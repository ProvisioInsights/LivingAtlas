import type { AtlasErrorRecord } from "./records.js";

/**
 * What a consumer catches, and why there is more than one class.
 *
 * The prior client had ONE error type with a `code` string covering
 * `http-error`, `json-rpc-error`, `invalid-response` and `network-error`. Every
 * refusal Atlas expressed — a history-floor refusal, a capability requirement, a
 * withheld record — arrived as the same shape with the interesting part stringified
 * inside `detail`, so a caller that wanted to branch had to pattern-match prose.
 *
 * Here the four things that can go wrong are four types, because a caller does
 * something different about each:
 *
 *  - `AtlasToolRefusal` — Atlas answered, in contract, and said no. The typed
 *    `atlas.error:v1` record is attached whole, `retryable` included. This is
 *    the common case and it is not an exception in the informal sense: a
 *    history-floor refusal is Atlas working correctly.
 *  - `AtlasCapabilityRequired` — the `-32021` MUST. Names the capabilities the
 *    client did not declare. Retrying the same bytes cannot work; declaring the
 *    capability is the caller changing the request.
 *  - `AtlasProtocolMismatch` — the `-32022` MUST. Names what the server speaks
 *    and what this client speaks, so the two sets can be compared rather than
 *    guessed at.
 *  - `AtlasContractViolation` — the server answered something the PUBLISHED
 *    schema refuses. Never softened into a warning: a consumer that accepts an
 *    unvalidated shape is how a contract stops being one.
 */

export class AtlasClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
  }
}

/** Atlas answered in contract and refused. The typed record travels whole. */
export class AtlasToolRefusal extends AtlasClientError {
  readonly tool: string;
  readonly record: AtlasErrorRecord;

  constructor(input: { tool: string; record: AtlasErrorRecord }) {
    super(`${input.tool} refused: ${input.record.code} — ${input.record.message}`);
    this.tool = input.tool;
    this.record = input.record;
  }

  get code(): string {
    return this.record.code;
  }

  /** Whether the IDENTICAL bytes could succeed later. Never "is this fixable". */
  get retryable(): boolean {
    return this.record.retryable;
  }
}

/**
 * `-32021`. The request needs a client capability this connection did not
 * declare.
 *
 * The typed payload the server built rides along in `record`: the spec puts the
 * result in `error.data.result`, and dropping it would lose the audit receipt
 * the reveal contract promises on every outcome, refusals included.
 */
export class AtlasCapabilityRequired extends AtlasClientError {
  readonly tool: string;
  readonly requiredCapabilities: Readonly<Record<string, unknown>>;
  readonly record: AtlasErrorRecord | undefined;
  readonly result: Record<string, unknown> | undefined;

  constructor(input: {
    tool: string;
    message: string;
    requiredCapabilities: Readonly<Record<string, unknown>>;
    record?: AtlasErrorRecord;
    result?: Record<string, unknown>;
  }) {
    super(`${input.tool} needs client capabilities this client did not declare: ${Object.keys(input.requiredCapabilities).sort().join(", ")}`);
    this.tool = input.tool;
    this.requiredCapabilities = input.requiredCapabilities;
    this.record = input.record;
    this.result = input.result;
  }
}

/**
 * `-32022`. Both sets are carried, never just the server's.
 *
 * `supported` alone tells a client what to try; `requested` is what lets it tell
 * a revision it chose from a revision some proxy rewrote underneath it.
 */
export class AtlasProtocolMismatch extends AtlasClientError {
  readonly requested: string | undefined;
  readonly serverSupports: readonly string[];
  readonly clientSpeaks: readonly string[];

  constructor(input: { requested?: string; serverSupports: readonly string[]; clientSpeaks: readonly string[] }) {
    super(
      `No protocol revision in common. This client speaks ${input.clientSpeaks.join(", ") || "(none)"}; ` +
        `the server supports ${input.serverSupports.join(", ") || "(unstated)"}` +
        (input.requested === undefined ? "." : `; the refused request named ${input.requested}.`)
    );
    this.requested = input.requested;
    this.serverSupports = [...input.serverSupports];
    this.clientSpeaks = [...input.clientSpeaks];
  }
}

/** A JSON-RPC error that is none of the above. Code and data are kept as sent. */
export class AtlasProtocolError extends AtlasClientError {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;

  constructor(input: { method: string; code: number; message: string; data?: unknown }) {
    super(`${input.method} failed with JSON-RPC ${input.code}: ${input.message}`);
    this.code = input.code;
    this.data = input.data;
    this.method = input.method;
  }
}

/**
 * The server answered something the published schema refuses.
 *
 * A hard failure rather than a warning, and the reason is asymmetric strictness:
 * a consumer that quietly accepts an unvalidated document is a consumer whose
 * bug reports arrive months later as "the data looks wrong". The offending
 * document is attached so the report can be exact.
 */
export class AtlasContractViolation extends AtlasClientError {
  readonly tool: string;
  readonly direction: "input" | "output";
  readonly errors: readonly string[];
  readonly document: unknown;

  constructor(input: { tool: string; direction: "input" | "output"; errors: readonly string[]; document: unknown }) {
    super(
      `${input.direction === "input" ? "Arguments for" : "The result of"} ${input.tool} do not satisfy the published ` +
        `${input.direction} schema: ${input.errors.join("; ")}`
    );
    this.tool = input.tool;
    this.direction = input.direction;
    this.errors = [...input.errors];
    this.document = input.document;
  }
}

/** The transport could not carry the request, or the process serving it went away. */
export class AtlasTransportError extends AtlasClientError {}
