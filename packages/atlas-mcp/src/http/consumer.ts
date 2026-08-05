import { randomBytes } from "node:crypto";
import { buildAtlasServer, type AtlasServerOptions } from "../server.js";
import { REVEAL_STATE_MIN_KEY_BYTES } from "../reveal-state.js";
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
 *
 * ## Why the reveal key is minted HERE and not inside the server
 *
 * `createMcpHandler` takes a server FACTORY and calls it once per REQUEST, so
 * `buildAtlasServer` runs again for every exchange on this listener. Anything a
 * server builds from `randomBytes` is therefore rebuilt with different bytes on
 * the next request — and `createRevealStateCodec` defaults its HMAC key exactly
 * that way, which is correct on stdio (one process, one codec, every round of a
 * flow) and silently fatal here. A `requestState` minted in round one verified
 * against a key that no longer exists by round two: `atlas.sensitive.reveal.v1`
 * escalated and could never be completed, on BOTH channels — `-32602
 * invalid_request_state` on the protocol channel and `invalid-request-state` on
 * the published `request_state` argument. The identical flow passed on stdio,
 * which is precisely the transport branch the contract promises no consumer will
 * ever have to make.
 *
 * So the key is bound to the LISTENER: one `randomBytes` here, threaded into
 * every per-request server, and the multi-round flow closes. A restart still
 * mints a new one, which keeps the property the stdio default was chosen for —
 * an owner decision that spans a restart fails closed rather than being honoured
 * by a process that has forgotten why it was asked. A multi-instance deployment
 * (several listeners behind one address) still MUST supply `revealStateKey`
 * explicitly, because two listeners are two keys for the same reason two
 * processes were.
 */

export type ServeAtlasHttpOptions = Omit<AtlasServerOptions, "capabilityRefusals" | "resolvePrincipal"> &
  AtlasHttpServeOptions & {
    /** Loopback only; defaults to `127.0.0.1`. */
    host?: string;
    port: number;
  };

/** The fetch handler alone, for a host that owns its own socket (and for tests). */
export function atlasConsumerHttpHandler(options: Omit<ServeAtlasHttpOptions, "port" | "host">) {
  // Read once, OUTSIDE the factory. Inside it this expression would be a fresh
  // key per request and the escalation could never complete — see the header.
  const revealStateKey = options.revealStateKey ?? randomBytes(REVEAL_STATE_MIN_KEY_BYTES);

  return atlasHttpFetchHandler(options, ({ resolvePrincipal, capabilityRefusals }) =>
    buildAtlasServer({ ...options, resolvePrincipal, capabilityRefusals, revealStateKey })
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
