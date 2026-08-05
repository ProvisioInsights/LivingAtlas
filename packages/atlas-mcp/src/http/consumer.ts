import { buildAtlasServer, type AtlasServerOptions } from "../server.js";
import { startAtlasHttpListener, type AtlasHttpListener } from "./listener.js";
import { atlasHttpFetchHandler, type AtlasHttpServeOptions } from "./serve.js";

/**
 * The consumer plane over Streamable HTTP.
 *
 * The mirror of `stdio.ts`, and deliberately as thin: it names the server core
 * and hands it to the shared edge. `buildAtlasServer` is imported unchanged, so
 * the twelve published tools, the audit rule, the grant check and the reveal
 * escalation are the SAME code that answers over a pipe. `parity.test.ts` holds
 * that claim to byte equality on the structured results rather than leaving it
 * as an intention.
 *
 * `capabilityRefusals` is not an input here, for the same reason it is not one
 * on stdio: the sink is only meaningful once something is wired to raise it, and
 * a caller that supplied one unwired would get a server that silently never
 * answers `-32021`. The edge owns it, per request.
 */

export type ServeAtlasHttpOptions = Omit<AtlasServerOptions, "capabilityRefusals" | "resolvePrincipal"> &
  AtlasHttpServeOptions & {
    /** Loopback only; defaults to `127.0.0.1`. */
    host?: string;
    port: number;
  };

/** The fetch handler alone, for a host that owns its own socket (and for tests). */
export function atlasConsumerHttpHandler(options: Omit<ServeAtlasHttpOptions, "port" | "host">) {
  return atlasHttpFetchHandler(options, ({ resolvePrincipal, capabilityRefusals }) =>
    buildAtlasServer({ ...options, resolvePrincipal, capabilityRefusals })
  );
}

export async function serveAtlasHttp(
  options: ServeAtlasHttpOptions
): Promise<AtlasHttpListener & { close: () => Promise<void> }> {
  const handler = atlasConsumerHttpHandler(options);
  const listener = await startAtlasHttpListener({
    fetch: handler.fetch,
    ...(options.host === undefined ? {} : { host: options.host }),
    port: options.port
  });

  return {
    ...listener,
    close: async () => {
      await listener.close();
      await handler.close();
    }
  };
}
