import type { LoadedContract } from "@living-atlas/atlas-contract";
import type { AuditCounts } from "./audit.js";
import type { GraphSource } from "./graph.js";
import type { Principal } from "./principal.js";
import type { RevealStateCodec, RevealStatePayload } from "./reveal-state.js";
import type { ErrorRecord } from "./results.js";

/**
 * What a handler is given, and what it may return.
 *
 * Note what is NOT on the context: the audit recorder. A handler physically
 * cannot write an audit event — it reports counts, and the dispatcher writes
 * exactly one event per call. That is the structural fix for the defect this
 * server exists to avoid: the prior code put `recordToolDecision` in the
 * handler's hands, a handler put it inside a whole-graph loop, and one
 * `object_list` call wrote ~58 MiB. Discipline did not hold; a type does.
 */
export type ToolContext = {
  principal: Principal;
  /** The revision this REQUEST named, from the validated `_meta` envelope. */
  protocolVersion: string;
  /** Exactly what the client declared. Never what the server hopes it supports. */
  clientCapabilities: Readonly<Record<string, unknown>>;
  now: Date;
  graph: GraphSource;
  contract: LoadedContract;
  reveal: RevealStateCodec;
  /** Verified MRTR payload for this round, or undefined when none was echoed. */
  requestState?: RevealStatePayload;
  /** Bare elicitation responses the client returned on a retry. Untrusted. */
  inputResponses?: Readonly<Record<string, unknown>>;
};

/** The counts and named subjects the dispatcher will write into the one event. */
export type AuditFacts = {
  outcome: "ok" | "refused" | "input-required" | "error";
  reasonCode?: string;
  counts: AuditCounts;
  /**
   * Ids the CALLER named. A handler that puts graph-produced ids here
   * reintroduces the unbounded-log defect, so every call site passes a slice of
   * its own arguments and nothing else.
   */
  subjects?: readonly string[];
};

export type ToolOutcome =
  /**
   * A normal result. `structured` is validated against the published output
   * schema before it leaves.
   *
   * `isError` marks a result that is BOTH a well-formed contract payload and a
   * failure — `atlas.sensitive.reveal.v1` refusing for want of the elicitation
   * capability, say. Its output schema requires the `audit` block on every
   * outcome "including a refusal", because a caller has to be told the attempt
   * was recorded; an audit trail a consumer does not know exists is one it
   * cannot reason about. Dropping to an untyped tool error would throw that
   * receipt away, so the result carries both the payload and the error flag.
   */
  | { kind: "complete"; structured: Record<string, unknown>; isError?: boolean; audit: AuditFacts }
  /**
   * A refusal the output schema cannot express — it becomes an MCP tool error
   * carrying the typed `atlas.error:v1`. Used where the contract's own output
   * has no `error` member, so the alternative would be inventing one.
   */
  | { kind: "refusal"; error: ErrorRecord; audit: AuditFacts }
  /**
   * The spec's `-32021`, which MUST reach the wire as a JSON-RPC ERROR and not
   * as a tool result: only an error carries `data.requiredCapabilities`, and a
   * conformant client branches on the numeric code.
   *
   * It is a distinct outcome KIND rather than a `complete` carrying a code
   * because a handler cannot raise it itself. `McpServer`'s built-in
   * `tools/call` catches every throw except `UrlElicitationRequired` and
   * flattens it into `{isError, content:[text]}` — verified against
   * `@modelcontextprotocol/server@2.0.0` — so the numeric code is lost from
   * inside a handler. The dispatcher raises it one seam further out, where the
   * SDK's catch cannot reach.
   *
   * `structured` is the typed payload the tool would otherwise have returned,
   * placeholder audit slot and all; the dispatcher fills the slot and carries
   * the whole thing in `error.data` so the receipt survives the change of
   * channel.
   */
  | {
      kind: "capability-required";
      /** In the `ClientCapabilities` SHAPE the spec's `data` member requires, not a name list. */
      requiredCapabilities: Record<string, unknown>;
      message: string;
      structured: Record<string, unknown>;
      audit: AuditFacts;
    }
  /**
   * The MRTR escalation. `prompt` and `schema` describe the elicitation; the
   * dispatcher mints and signs the state, so a handler never touches the key.
   */
  | {
      kind: "escalate";
      prompt: string;
      requestId: string;
      payload: RevealStatePayload;
      /** Also returned as a complete result, for a client that will not retry. */
      inBand: (state: { requestState: string; expiresAt: string }) => Record<string, unknown>;
      audit: AuditFacts;
    };

export type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolOutcome> | ToolOutcome;
