import { capabilityErrorFor, type CapabilityRefusalSink } from "../capability-refusal.js";

/**
 * `-32021` on the HTTP wire.
 *
 * On stdio the swap is a transport decorator: `capabilityRefusalTransport` sits
 * between the protocol layer and the pipe and replaces an outbound RESULT with
 * the MissingRequiredClientCapability error the specification makes a MUST. The
 * HTTP serving entry has no such seam — `createMcpHandler` takes a server
 * FACTORY and owns its transport internally, so there is nothing to decorate.
 *
 * The seam moves to the response; the RULE does not. Both transports call the
 * same `capabilityErrorFor`, which is a pure function over one wire message and
 * the sink. That matters more than where it is applied: two implementations of
 * "when does a result become -32021" are two implementations that can drift, and
 * the one that drifts is the one nobody is looking at. Here the answer to that
 * question exists once, and this file only decides which bytes to feed it.
 *
 * Both response shapes are handled, because both are reachable. A single JSON
 * body is what a refusal produces today; `responseMode: 'auto'` upgrades to SSE
 * the moment a handler emits anything before its result, and a rewrite that
 * silently stopped working when a handler grew a progress notification would be
 * the same defect wearing a different hat.
 */

/** SSE frames are separated by a blank line, which may be LF or CRLF delimited. */
const FRAME_BOUNDARY = /\r?\n\r?\n/;

function rewriteJsonText(text: string, sink: CapabilityRefusalSink): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON this function can reason about. Passed through untouched rather
    // than replaced: a body it cannot parse is a body it must not claim to have
    // understood.
    return undefined;
  }
  const replacement = capabilityErrorFor(parsed, sink);
  return replacement === undefined ? undefined : JSON.stringify(replacement);
}

/**
 * Rewrite the `data:` payload of one SSE frame, preserving every other field.
 *
 * The `event:`, `id:` and comment lines are carried through verbatim. A frame
 * whose data is not a swappable result is returned unchanged, so this is safe to
 * apply to every frame on the stream — including `notifications/progress` frames
 * and the keep-alive comments the SDK emits.
 *
 * Multi-line `data:` fields are concatenated with newlines per the SSE
 * specification before parsing, and a rewritten payload is re-emitted as a
 * single `data:` line because the replacement is compact JSON with no newlines.
 */
export function rewriteSseFrame(frame: string, sink: CapabilityRefusalSink): string {
  const lines = frame.split(/\r?\n/);
  const dataIndexes: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("data:")) dataIndexes.push(index);
  }
  if (dataIndexes.length === 0) return frame;

  const payload = dataIndexes.map((index) => (lines[index] ?? "").slice("data:".length).replace(/^ /, "")).join("\n");
  const rewritten = rewriteJsonText(payload, sink);
  if (rewritten === undefined) return frame;

  const first = dataIndexes[0];
  const rebuilt: string[] = [];
  for (const [index, line] of lines.entries()) {
    // The whole payload is re-emitted on the FIRST data line and the remaining
    // ones are dropped: the replacement is compact JSON with no newlines, so it
    // needs exactly one. Every non-data line keeps its position.
    if (index === first) rebuilt.push(`data: ${rewritten}`);
    else if (!dataIndexes.includes(index)) rebuilt.push(line);
  }
  return rebuilt.join("\n");
}

/**
 * Apply the capability swap to a whole SSE body, frame by frame.
 *
 * Exported for the tests, which assert the rewrite against literal SSE bytes
 * rather than through a live stream — the same reason `gateInbound` and
 * `capabilityErrorFor` are exported separately from the transports that use
 * them.
 */
export function rewriteSseBody(body: string, sink: CapabilityRefusalSink): string {
  const parts = body.split(FRAME_BOUNDARY);
  const separators = body.match(new RegExp(FRAME_BOUNDARY, "g")) ?? [];
  return parts
    .map((frame, index) => (frame.length === 0 ? frame : rewriteSseFrame(frame, sink)) + (separators[index] ?? ""))
    .join("");
}

/**
 * Replace an outbound HTTP response when this exchange parked a refusal.
 *
 * A response with nothing parked is returned by IDENTITY — same object, body
 * unread — so the common path costs nothing and a streaming response keeps
 * streaming. The sink is consulted first precisely so that reading the body is
 * something this function does only when it already knows it has work to do.
 */
export async function applyCapabilityRefusal(response: Response, sink: CapabilityRefusalSink): Promise<Response> {
  if (sink.size === 0) return response;

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const streamed = await response.text();
    const rewritten = rewriteSseBody(streamed, sink);
    return new Response(rewritten, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  const text = await response.text();
  const rewritten = rewriteJsonText(text, sink);
  // `text` when nothing matched: the body has already been consumed, so the
  // original Response object can no longer be returned and an equivalent one is
  // rebuilt around the same bytes.
  return new Response(rewritten ?? text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}
