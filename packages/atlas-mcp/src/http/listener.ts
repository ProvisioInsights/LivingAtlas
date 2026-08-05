import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The socket half: a `node:http` server bound to loopback, and the two
 * conversions between Node's streams and the web-standard `Request`/`Response`
 * the MCP handler speaks.
 *
 * Deliberately plane-agnostic — it takes a `fetch` function and knows nothing
 * about Atlas. Everything that decides WHO may call and WHAT they may reach
 * lives in `serve.ts` and the plane entries, so a second listener (a different
 * runtime, a test harness) cannot acquire a different authorization story by
 * being written somewhere else.
 */

/**
 * The addresses a listener may bind.
 *
 * An allowlist rather than a `!== "0.0.0.0"` check, because the ways to say "every
 * interface" outnumber the ways to say loopback: `0.0.0.0`, `::`, the empty
 * string, and an omitted host all mean the same thing to `net.Server.listen`, and
 * a deny-list would have to enumerate them correctly forever. This enumerates the
 * safe set instead, so a host it has never heard of is refused rather than served.
 */
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;

export type AtlasHttpListenerOptions = {
  fetch: (request: Request) => Promise<Response>;
  /** Loopback only. Defaults to `127.0.0.1`. */
  host?: string;
  /** `0` asks the OS for a free port, which is what the tests use. */
  port: number;
};

export type AtlasHttpListener = {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  close: () => Promise<void>;
};

/**
 * Read a port from the environment.
 *
 * Exported so both plane CLIs read it the same way, and so "the port is
 * configuration" is a statement with one implementation. A value that is not a
 * port throws rather than falling back to a default: a typo that silently
 * listened somewhere else would be discovered by something else connecting.
 */
export function portFromEnv(variable: string, environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment[variable];
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error(`${variable} is not set: an HTTP listener needs a port and this one has no default`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${variable} is not a port number: ${raw}`);
  }
  return port;
}

function headersFrom(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return headers;
}

function requestFrom(
  incoming: IncomingMessage,
  origin: string,
  body: Buffer,
  signal: AbortSignal
): Request {
  const method = incoming.method ?? "GET";
  const bodyless = method === "GET" || method === "HEAD" || body.length === 0;
  // Decoded as UTF-8 text rather than passed as bytes. The MCP endpoint accepts
  // exactly one media type — a POST whose Content-Type is not `application/json`
  // is answered `415` before its body is looked at — so there is no binary body
  // for this to mangle. It is also the only body type this workspace can express:
  // `@cloudflare/workers-types` is a global `types` entry and its `BodyInit` does
  // not admit `Buffer` or a bare `Uint8Array`.
  return new Request(`${origin}${incoming.url ?? "/"}`, {
    method,
    headers: headersFrom(incoming),
    ...(bodyless ? {} : { body: body.toString("utf8") }),
    signal
  });
}

async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers.entries()) headers[name] = value;
  outgoing.writeHead(response.status, headers);

  if (response.body === null) {
    outgoing.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!outgoing.write(Buffer.from(value))) {
        // Backpressure. Without this an SSE stream that outruns the socket
        // buffers the whole response in memory, which is precisely the latency
        // the `X-Accel-Buffering: no` header exists to prevent.
        await new Promise<void>((resolve) => outgoing.once("drain", resolve));
      }
    }
  } catch {
    // The peer went away mid-stream. Nothing to report: the abort below has
    // already cancelled the exchange.
  } finally {
    reader.releaseLock();
    outgoing.end();
  }
}

export async function startAtlasHttpListener(options: AtlasHttpListenerOptions): Promise<AtlasHttpListener> {
  const host = options.host ?? "127.0.0.1";
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(host)) {
    throw new Error(
      `refusing to bind ${host}: this server holds a decrypted view of a personal graph and is reachable without a network hop by design, so it binds loopback only (${LOOPBACK_HOSTS.join(", ")})`
    );
  }

  const bracketed = host.includes(":") ? `[${host}]` : host;
  let origin = `http://${bracketed}`;

  const server: NodeHttpServer = createServer((incoming, outgoing) => {
    /**
     * Cancellation, which on this transport is the ENTIRE cancellation
     * mechanism: the revision defines no `notifications/cancelled` over
     * Streamable HTTP, so closing the response stream is itself the signal and a
     * server MUST treat it as cancelling that request.
     *
     * Wired to the RESPONSE closing early, never to the request stream. A POST's
     * `IncomingMessage` emits `close` as soon as its body has been read, which
     * for every well-formed request is long before the answer exists — aborting
     * on that would cancel each exchange the moment it was understood.
     * `writableFinished` is the discriminator: false means the socket died with
     * the answer unsent.
     */
    const controller = new AbortController();
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) controller.abort();
    });

    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      void (async () => {
        try {
          const request = requestFrom(incoming, origin, Buffer.concat(chunks), controller.signal);
          await writeResponse(await options.fetch(request), outgoing);
        } catch {
          if (!outgoing.headersSent) {
            outgoing.writeHead(500, { "content-type": "application/json" });
            outgoing.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error." } }));
            return;
          }
          outgoing.end();
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  origin = `http://${bracketed}:${port}`;

  return {
    port,
    host,
    url: origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
