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
 *
 * ## Why the SSE path may not consult the sink at fetch time
 *
 * It is tempting to decide "is there anything to swap" once, when
 * `handler.fetch` resolves, and hand a streaming response straight back when the
 * answer is no. That was the code here, and it was wrong for a measured reason:
 * on an SSE upgrade the SDK's `PerRequestHTTPServerTransport.upgradeToSse()`
 * calls `settleResponse` the moment the FIRST notification is written — before
 * the handler has produced its result, and therefore before the refusal is
 * parked. The sink is empty at that instant no matter what the handler is about
 * to do, so the check answered "nothing to swap" and the raw `result` frame went
 * out unrewritten. The spec MUST was silently unmet, and it was unmet in exactly
 * the scenario the paragraph above says is the reason both shapes are handled.
 *
 * So an event-stream body is piped through a TRANSFORM instead. The sink is
 * consulted as each frame is serialised, which is the only instant at which the
 * question has a settled answer, and the response keeps streaming rather than
 * being buffered to a string. The JSON path keeps its fetch-time check, and
 * legitimately: `Response.json(message)` is built from the terminal message, so
 * anything parkable has already been parked by the time that body exists.
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
 * The end offset of the LAST complete frame boundary in `text`, or `0`.
 *
 * A stream arrives in chunks that respect nothing, so a buffer may end
 * mid-boundary — `"…\n"` could be a frame that ended or the first half of a
 * separator. Only the part up to a boundary that has definitely closed is
 * handed on; the tail stays buffered until more bytes prove what it is.
 */
function lastBoundaryEnd(text: string): number {
  const pattern = new RegExp(FRAME_BOUNDARY, "g");
  let end = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    end = match.index + match[0].length;
    match = pattern.exec(text);
  }
  return end;
}

/**
 * Rewrite an SSE body frame by frame, AS IT STREAMS.
 *
 * Exported so the streaming behaviour is testable without a server: what has to
 * be true is that a refusal parked AFTER the headers went out still reaches the
 * wire, which is a statement about when the sink is read and not about what the
 * frame rewriter does with it.
 *
 * Complete frames are forwarded as soon as they arrive, so a long-running
 * exchange still streams; only a partial trailing frame is held, because a frame
 * cannot be rewritten until it is whole.
 */
export function capabilityRefusalTransform(sink: CapabilityRefusalSink): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      const end = lastBoundaryEnd(buffered);
      if (end === 0) return;
      const complete = buffered.slice(0, end);
      buffered = buffered.slice(end);
      controller.enqueue(encoder.encode(rewriteSseBody(complete, sink)));
    },
    flush(controller) {
      // A stream that ended without a final blank line still has to go out, and
      // the rewriter handles an unterminated frame the same as a terminated one.
      buffered += decoder.decode();
      if (buffered.length === 0) return;
      controller.enqueue(encoder.encode(rewriteSseBody(buffered, sink)));
    }
  });
}

/**
 * The HTTP status a `-32021` answer carries.
 *
 * `400`, and not the `200` the swapped-out RESULT was travelling on. The
 * revision mandates the status on the error itself with no origin condition —
 * `MissingRequiredClientCapability` is the one in-band code that is not answered
 * `200` — and `@modelcontextprotocol/server@2.0.0` produces exactly that when it
 * raises the error itself, from its own `LADDER_ERROR_HTTP_STATUS` table. This
 * seam raises the error AFTER the SDK has already chosen a status for the result
 * it was replacing, so carrying that status through would leave a client
 * branching on HTTP status unable to see a refusal the same server answers `400`
 * on every other path. Only the single-JSON shape needs it: on a stream the
 * status belongs to the stream, and the SDK's own table agrees — it applies the
 * ladder status only when the exchange has not upgraded.
 */
export const CAPABILITY_REFUSAL_HTTP_STATUS = 400;

/**
 * Replace an outbound HTTP response when this exchange parked a refusal.
 *
 * A single-JSON response with nothing parked is returned by IDENTITY — same
 * object, body unread — because that body is already complete when this runs, so
 * an empty sink then is an empty sink for good.
 *
 * An event-stream response is ALWAYS wrapped, empty sink or not. The sink cannot
 * be believed at this instant on that path: the response settled when the
 * stream opened, which is before the handler produced the result that would park
 * a refusal. See the header for the measurement.
 */
export async function applyCapabilityRefusal(response: Response, sink: CapabilityRefusalSink): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const body = response.body;
    if (body === null) return response;
    return new Response(body.pipeThrough(capabilityRefusalTransform(sink)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  if (sink.size === 0) return response;

  const text = await response.text();
  const rewritten = rewriteJsonText(text, sink);
  // `text` when nothing matched: the body has already been consumed, so the
  // original Response object can no longer be returned and an equivalent one is
  // rebuilt around the same bytes — with the status it arrived on, because
  // nothing was swapped.
  return new Response(rewritten ?? text, {
    status: rewritten === undefined ? response.status : CAPABILITY_REFUSAL_HTTP_STATUS,
    statusText: response.statusText,
    headers: response.headers
  });
}
