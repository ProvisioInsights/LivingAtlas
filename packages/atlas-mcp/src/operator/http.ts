import { startAtlasHttpListener, type AtlasHttpListener } from "../http/listener.js";
import { atlasHttpFetchHandler, type AtlasHttpServeOptions } from "../http/serve.js";
import { buildOperatorServer, type OperatorServerOptions } from "./server.js";

/**
 * The operator plane over Streamable HTTP.
 *
 * A separate entry from the consumer's, exactly as `operator/stdio.ts` is
 * separate from `stdio.ts`, and for the reason ADR 0015 gives: the two planes
 * are two servers with two tool tables bound to two credential classes, and a
 * single entry serving both would be the one place they meet. The shared thing
 * is the transport EDGE — origin checking, bearer binding, the protocol-version
 * header — which knows nothing about either tool set.
 *
 * The plane separation survives the new transport untouched, and by
 * construction: `resolvePrincipal` here is built for `plane: "operator"`, so a
 * consumer credential presented against this listener resolves to nothing
 * whatever port it arrives on. The bearer token does not widen a grant; it only
 * carries the same secret the `_meta` channel carries on stdio.
 *
 * No capability-refusal sink: the operator plane has no reveal escalation, so it
 * has nothing to park. The edge still builds one per request — an unused empty
 * sink costs a `Map` and keeps one code path across both planes.
 */

export type ServeOperatorHttpOptions = Omit<OperatorServerOptions, "resolvePrincipal"> &
  AtlasHttpServeOptions & {
    /** Loopback only; defaults to `127.0.0.1`. */
    host?: string;
    port: number;
  };

/** The fetch handler alone, for a host that owns its own socket (and for tests). */
export function operatorHttpHandler(options: Omit<ServeOperatorHttpOptions, "port" | "host">) {
  return atlasHttpFetchHandler(options, ({ resolvePrincipal }) =>
    buildOperatorServer({ ...options, resolvePrincipal })
  );
}

export async function serveOperatorHttp(
  options: ServeOperatorHttpOptions
): Promise<AtlasHttpListener & { close: () => Promise<void> }> {
  const handler = operatorHttpHandler(options);
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
