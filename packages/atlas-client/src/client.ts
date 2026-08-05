import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolErrorCode,
  SERVER_INFO_META_KEY
} from "@modelcontextprotocol/server";
import {
  CONTRACT_PROTOCOL_VERSION,
  CONTRACT_REVISION,
  CONTRACT_TOOL_NAMES,
  ContractValidator,
  createContractValidator,
  loadContract,
  packageRoot,
  schemaDirectory,
  type ContractToolName,
  type LoadedContract
} from "@living-atlas/atlas-contract";
import {
  AtlasCapabilityRequired,
  AtlasClientError,
  AtlasContractViolation,
  AtlasProtocolError,
  AtlasProtocolMismatch,
  AtlasToolRefusal
} from "./errors.js";
import type { AtlasErrorRecord, AtlasPage } from "./records.js";
import type { AtlasToolShapes } from "./tools.js";
import type { AtlasTransport, JsonRpcRequest, JsonRpcResponse } from "./transport.js";

/**
 * The typed consumer client for the published 2026.08.0 plane.
 *
 * Four properties are load-bearing, and each replaces a specific defect in the
 * client this rewrites:
 *
 *  - **It reads the PUBLISHED bytes.** Schemas are loaded from
 *    `packages/atlas-contract/schema/<revision>/`, the same documents the server
 *    registers from. The prior client carried its own hand-written argument
 *    shapes for thirty tools, so the request it built and the request the server
 *    would accept were two documents, and only one of them was reviewed.
 *
 *  - **It validates what comes back, and refuses rather than softens.** A result
 *    that fails the tool's own published output schema raises
 *    `AtlasContractViolation`. The prior client returned `unknown` from every
 *    call and left every consumer to guess; a consumer that quietly accepts an
 *    unvalidated document is a consumer whose bug reports arrive months later as
 *    "the data looks wrong".
 *
 *  - **It never branches on how it connected.** The transport is a seam with one
 *    method. Everything that could differ between deployments — limits, reachable
 *    tiers, writable predicates — is read from `atlas.scope.describe.v1`, which
 *    is what that tool is for.
 *
 *  - **It declares only capabilities it can actually service.** `elicitation` is
 *    declared when, and only when, a decision callback was supplied. A client
 *    that advertised elicitation it cannot answer would receive a request nobody
 *    can answer and wait on it forever; the `-32021` refusal the server owes an
 *    undeclared capability only works if clients declare honestly.
 */

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

/**
 * The `_meta` member a request presents its credential on.
 *
 * Declared here rather than imported from the server package: a client that
 * depended on `@living-atlas/atlas-mcp` at runtime would invert the dependency
 * between a consumer and the thing it consumes, and would import an entire
 * server to read one string. The cost of restating it is drift, so
 * `credential-meta-key.test.ts` asserts this constant equals the server's — the
 * server package is a DEV dependency, present for that test and for nothing else.
 *
 * Its natural long-term home is `@living-atlas/atlas-contract`: how a consumer
 * authenticates on this plane is a property of the plane, not of one server.
 * Moving it is a contract change and belongs to whoever owns the next revision.
 */
export const ATLAS_CREDENTIAL_META_KEY = "io.livingatlas/credential";

/**
 * How the credential for one REQUEST is obtained.
 *
 * A function is allowed because credentials are per-request input on this
 * revision, not connection state: a host that rotates a secret, or that serves
 * several principals over one pipe, supplies a function and the right credential
 * rides each request. A constant string is the simple case, not the model.
 */
export type AtlasCredentialSupplier = string | (() => string | Promise<string>);

export type ElicitationRequest = {
  tool: ContractToolName;
  /** The key the answer must be filed under. Echoed verbatim; never invented. */
  requestId: string;
  method: string;
  message: string;
  requestedSchema: unknown;
  /**
   * The signed state this escalation is bound to.
   *
   * Handed over because a host that must persist an escalation and resume it in
   * another process needs it, and because the codec is SIGNED and not
   * encrypted — a client can already base64url-decode it, so withholding it here
   * would protect nothing while making the resumable case impossible. What is
   * inside is a redaction id and a request id: no key material, no plaintext, no
   * tier. Echo it VERBATIM. Editing a byte is the tamper the server's HMAC
   * refuses, and editing which record it names is the substitution the handler's
   * object check refuses.
   */
  requestState: string;
};

export type ElicitationDecision =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

/**
 * The owner's decision, asked of whoever is hosting this client.
 *
 * Pluggable and REQUIRED for any disclosure, because the decision is not the
 * client's to make. A default that accepted would turn every escalation into a
 * formality, which is the failure mode the whole multi-round-trip flow exists to
 * prevent.
 */
export type ElicitationDecider = (request: ElicitationRequest) => ElicitationDecision | Promise<ElicitationDecision>;

export type AtlasConsumerClientOptions = {
  transport: AtlasTransport;
  /** Presented on every request. Absent means every call is refused, loudly. */
  credential?: AtlasCredentialSupplier;
  clientInfo?: { name: string; version: string };
  /**
   * Supplying this DECLARES the `elicitation` capability; omitting it declares
   * none, and a reveal then comes back as the `-32021` the spec requires. That
   * is the honest coupling: the capability a client advertises and the capability
   * it can service are the same fact, so they are the same field.
   */
  elicitation?: ElicitationDecider;
  /**
   * Extra capabilities to declare, for a host that services them itself. Merged
   * under `elicitation`, never over it: a caller cannot declare a capability the
   * client has no decider for by passing it here.
   */
  capabilities?: Readonly<Record<string, unknown>>;
  /** Defaults to the published bytes shipped with `@living-atlas/atlas-contract`. */
  contract?: LoadedContract;
};

export type AtlasServerDescription = {
  supportedVersions: readonly string[];
  capabilities: Readonly<Record<string, unknown>>;
  instructions: string | undefined;
  serverInfo: { name: string; version: string } | undefined;
  ttlMs: number | undefined;
  cacheScope: string | undefined;
};

export type AtlasToolListing = {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// the published contract, loaded once per process
// ---------------------------------------------------------------------------

let sharedContract: LoadedContract | undefined;
let sharedValidator: ContractValidator | undefined;

/** The bytes a consumer would fetch, loaded from the contract package's own directory. */
export function publishedContract(): LoadedContract {
  sharedContract ??= loadContract(schemaDirectory(packageRoot(), CONTRACT_REVISION));
  return sharedContract;
}

function validatorFor(contract: LoadedContract): ContractValidator {
  if (contract === sharedContract) {
    sharedValidator ??= createContractValidator(contract);
    return sharedValidator;
  }
  return createContractValidator(contract);
}

// ---------------------------------------------------------------------------
// wire helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringMember(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The first text block of a tool result, parsed. Where an out-of-schema refusal travels. */
function firstTextPayload(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const content = result["content"];
  if (!Array.isArray(content)) return undefined;
  const first = asRecord(content[0]);
  const text = stringMember(first, "text");
  if (text === undefined) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** A tool result that arrived as an escalation rather than as an answer. */
type InputRequiredResult = {
  requestState: string;
  inputRequests: Record<string, { method: string; params: Record<string, unknown> }>;
};

function readInputRequests(result: Record<string, unknown>): InputRequiredResult | undefined {
  const state = stringMember(result, "requestState");
  const requests = asRecord(result["inputRequests"]);
  if (state === undefined || requests === undefined) return undefined;
  const parsed: InputRequiredResult["inputRequests"] = {};
  for (const [key, value] of Object.entries(requests)) {
    const entry = asRecord(value);
    const method = stringMember(entry, "method");
    if (entry === undefined || method === undefined) continue;
    parsed[key] = { method, params: asRecord(entry["params"]) ?? {} };
  }
  return { requestState: state, inputRequests: parsed };
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

export class AtlasConsumerClient {
  private readonly transport: AtlasTransport;
  private readonly contract: LoadedContract;
  private readonly validator: ContractValidator;
  private readonly credential: AtlasCredentialSupplier | undefined;
  private readonly clientInfo: { name: string; version: string };
  private readonly decide: ElicitationDecider | undefined;
  private readonly declaredCapabilities: Readonly<Record<string, unknown>>;

  /** The single revision this client's bytes describe. It speaks no other. */
  readonly speaks: readonly string[] = [CONTRACT_PROTOCOL_VERSION];

  private negotiated: string = CONTRACT_PROTOCOL_VERSION;
  private description: AtlasServerDescription | undefined;
  private descriptionExpiresAt = 0;
  private nextId = 1;

  constructor(options: AtlasConsumerClientOptions) {
    this.transport = options.transport;
    this.contract = options.contract ?? publishedContract();
    this.validator = validatorFor(this.contract);
    this.credential = options.credential;
    this.clientInfo = options.clientInfo ?? { name: "living-atlas-consumer-client", version: CONTRACT_REVISION };
    this.decide = options.elicitation;

    // `elicitation` is DERIVED from the decider and never taken from
    // `capabilities`. Spreading the derived value on top is not enough — with no
    // decider the derived value is nothing, and a caller-supplied `elicitation`
    // would survive underneath it. So the key is removed outright: a client that
    // advertises an owner decision it cannot answer receives a request nobody can
    // answer and waits on it, and the `-32021` the server owes an undeclared
    // capability only works if clients declare honestly.
    const declared: Record<string, unknown> = { ...(options.capabilities ?? {}) };
    if (this.decide === undefined) delete declared["elicitation"];
    else declared["elicitation"] = {};
    this.declaredCapabilities = declared;
  }

  /** The contract revision this client's bytes describe. */
  get revision(): string {
    return this.contract.manifest.contract_revision;
  }

  /** The protocol revision currently in use. Set by negotiation, never by a caller. */
  get protocolVersion(): string {
    return this.negotiated;
  }

  /** Whether this client declared it can service an owner decision. */
  get canElicit(): boolean {
    return this.decide !== undefined;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  // -------------------------------------------------------------------------
  // discovery
  // -------------------------------------------------------------------------

  /**
   * `server/discover`, cached for as long as the server said to hold it.
   *
   * The TTL comes from the answer, not from a number chosen here: the server
   * publishes how long a description of itself stays valid, and a client that
   * held it longer would be reasoning about a surface that has moved.
   */
  async discover(options: { refresh?: boolean } = {}): Promise<AtlasServerDescription> {
    if (!options.refresh && this.description !== undefined && Date.now() < this.descriptionExpiresAt) {
      return this.description;
    }

    const result = await this.send("server/discover", {});
    const supported = Array.isArray(result["supportedVersions"])
      ? result["supportedVersions"].filter((entry): entry is string => typeof entry === "string")
      : [];
    const meta = asRecord(result["_meta"]);
    const serverInfo = asRecord(meta?.[SERVER_INFO_META_KEY]);
    const ttl = typeof result["ttlMs"] === "number" ? result["ttlMs"] : undefined;

    const description: AtlasServerDescription = {
      supportedVersions: supported,
      capabilities: asRecord(result["capabilities"]) ?? {},
      instructions: stringMember(result, "instructions"),
      serverInfo:
        serverInfo === undefined
          ? undefined
          : { name: String(serverInfo["name"] ?? ""), version: String(serverInfo["version"] ?? "") },
      ttlMs: ttl,
      cacheScope: stringMember(result, "cacheScope")
    };

    // A server that named its revisions and named none this client speaks is a
    // mismatch discovered HERE rather than on the first tool call, where it
    // would arrive as an unexplained refusal.
    if (description.supportedVersions.length > 0 && !description.supportedVersions.includes(this.negotiated)) {
      const common = description.supportedVersions.find((version) => this.speaks.includes(version));
      if (common === undefined) {
        throw new AtlasProtocolMismatch({ serverSupports: description.supportedVersions, clientSpeaks: this.speaks });
      }
      this.negotiated = common;
    }

    this.description = description;
    this.descriptionExpiresAt = Date.now() + (ttl ?? 0);
    return description;
  }

  /**
   * The tools THIS credential may call.
   *
   * The set may legitimately vary by the credential presented, so it is asked
   * per client rather than cached across them, and a tool that is absent is
   * absent because this credential may not call it — not because the server does
   * not have it.
   */
  async listTools(): Promise<AtlasToolListing[]> {
    await this.ensureDiscovered();
    const result = await this.send("tools/list", {});
    const tools = result["tools"];
    if (!Array.isArray(tools)) {
      throw new AtlasContractViolation({
        tool: "tools/list",
        direction: "output",
        errors: ["the result carried no tools array"],
        document: result
      });
    }
    return tools.flatMap((entry): AtlasToolListing[] => {
      const record = asRecord(entry);
      const name = stringMember(record, "name");
      if (record === undefined || name === undefined) return [];
      return [
        {
          name,
          ...(stringMember(record, "title") === undefined ? {} : { title: stringMember(record, "title") as string }),
          ...(stringMember(record, "description") === undefined
            ? {}
            : { description: stringMember(record, "description") as string }),
          ...(asRecord(record["annotations"]) === undefined
            ? {}
            : { annotations: asRecord(record["annotations"]) as Record<string, unknown> })
        }
      ];
    });
  }

  private async ensureDiscovered(): Promise<void> {
    if (this.description !== undefined && Date.now() < this.descriptionExpiresAt) return;
    await this.discover();
  }

  // -------------------------------------------------------------------------
  // the twelve tools
  // -------------------------------------------------------------------------

  describeContract(args: AtlasToolShapes["atlas.contract.describe.v1"]["args"] = {}): Promise<AtlasToolShapes["atlas.contract.describe.v1"]["result"]> {
    return this.call("atlas.contract.describe.v1", args);
  }

  describeScope(): Promise<AtlasToolShapes["atlas.scope.describe.v1"]["result"]> {
    return this.call("atlas.scope.describe.v1", {});
  }

  resolveEntities(args: AtlasToolShapes["atlas.entity.resolve.v1"]["args"]): Promise<AtlasToolShapes["atlas.entity.resolve.v1"]["result"]> {
    return this.call("atlas.entity.resolve.v1", args);
  }

  readEntities(args: AtlasToolShapes["atlas.entity.read.v1"]["args"]): Promise<AtlasToolShapes["atlas.entity.read.v1"]["result"]> {
    return this.call("atlas.entity.read.v1", args);
  }

  queryAssertions(args: AtlasToolShapes["atlas.assertion.query.v1"]["args"] = {}): Promise<AtlasToolShapes["atlas.assertion.query.v1"]["result"]> {
    return this.call("atlas.assertion.query.v1", args);
  }

  readAssertions(args: AtlasToolShapes["atlas.assertion.read.v1"]["args"]): Promise<AtlasToolShapes["atlas.assertion.read.v1"]["result"]> {
    return this.call("atlas.assertion.read.v1", args);
  }

  walkNeighbors(args: AtlasToolShapes["atlas.graph.neighbors.v1"]["args"]): Promise<AtlasToolShapes["atlas.graph.neighbors.v1"]["result"]> {
    return this.call("atlas.graph.neighbors.v1", args);
  }

  searchText(args: AtlasToolShapes["atlas.text.search.v1"]["args"]): Promise<AtlasToolShapes["atlas.text.search.v1"]["result"]> {
    return this.call("atlas.text.search.v1", args);
  }

  readChanges(args: AtlasToolShapes["atlas.changes.read.v1"]["args"]): Promise<AtlasToolShapes["atlas.changes.read.v1"]["result"]> {
    return this.call("atlas.changes.read.v1", args);
  }

  proposeAssertions(args: AtlasToolShapes["atlas.assertion.propose.v1"]["args"]): Promise<AtlasToolShapes["atlas.assertion.propose.v1"]["result"]> {
    return this.call("atlas.assertion.propose.v1", args);
  }

  readSubmission(args: AtlasToolShapes["atlas.submission.read.v1"]["args"]): Promise<AtlasToolShapes["atlas.submission.read.v1"]["result"]> {
    return this.call("atlas.submission.read.v1", args);
  }

  /**
   * Ask for the record behind a redaction stub, carrying the owner decision
   * through whichever escalation channel the server chose.
   *
   * Both channels are handled because both exist on this revision and a server
   * may be configured for either. The PROTOCOL channel is
   * `resultType: "input_required"`; the IN-BAND channel is a complete result
   * carrying `outcome: "input-required"`, which exists for a harness that renders
   * tool output but implements no retry. Exactly one round of escalation is
   * followed: a second one is refused rather than looped on, because a server
   * that escalates the answer to its own escalation is a server this client
   * cannot make progress against, and retrying would hide that.
   */
  async revealSensitive(
    args: AtlasToolShapes["atlas.sensitive.reveal.v1"]["args"]
  ): Promise<AtlasToolShapes["atlas.sensitive.reveal.v1"]["result"]> {
    const tool = "atlas.sensitive.reveal.v1" as const;
    const first = await this.callRaw(tool, args);

    if (first.kind === "input-required") {
      const responses = await this.answerElicitations(tool, first.escalation.inputRequests, first.escalation.requestState);
      const second = await this.callRaw(tool, args, {
        requestState: first.escalation.requestState,
        inputResponses: responses
      });
      if (second.kind !== "complete") {
        throw new AtlasClientError(`${tool} escalated again after an owner decision was supplied; this client follows exactly one round.`);
      }
      return second.structured as AtlasToolShapes["atlas.sensitive.reveal.v1"]["result"];
    }

    const structured = first.structured as AtlasToolShapes["atlas.sensitive.reveal.v1"]["result"];
    const inBand = structured.input_request;
    if (structured.outcome === "input-required" && inBand !== undefined) {
      const responses = await this.answerElicitations(
        tool,
        { [inBand.request_id]: { method: "elicitation/create", params: { message: inBand.prompt } } },
        inBand.request_state
      );
      // The state rides as a published ARGUMENT — the in-band channel's whole
      // point — while the owner's answer still rides on `inputResponses`,
      // because this revision gives an owner decision no other channel. A client
      // with genuinely no multi-round-trip support can echo the state but cannot
      // convey the answer, and gets `owner-decision-missing`. That is a real gap
      // in the in-band form, not a gap in this client.
      const second = await this.callRaw(tool, { ...args, request_state: inBand.request_state }, { inputResponses: responses });
      if (second.kind !== "complete") {
        throw new AtlasClientError(`${tool} escalated again after an owner decision was supplied; this client follows exactly one round.`);
      }
      return second.structured as AtlasToolShapes["atlas.sensitive.reveal.v1"]["result"];
    }

    return structured;
  }

  private async answerElicitations(
    tool: ContractToolName,
    requests: Record<string, { method: string; params: Record<string, unknown> }>,
    requestState: string
  ): Promise<Record<string, ElicitationDecision>> {
    const decide = this.decide;
    if (decide === undefined) {
      // Unreachable against a conformant server — it owes `-32021` to a client
      // that declared no elicitation — but stated as a refusal rather than a
      // non-null assertion, because guessing an owner's answer is the one thing
      // this client must never do.
      throw new AtlasClientError(
        `${tool} asked for an owner decision, but this client declared no elicitation capability and has no decider to answer with.`
      );
    }

    const answers: Record<string, ElicitationDecision> = {};
    for (const [requestId, request] of Object.entries(requests)) {
      answers[requestId] = await decide({
        tool,
        requestId,
        method: request.method,
        message: String(request.params["message"] ?? ""),
        requestedSchema: request.params["requestedSchema"],
        requestState
      });
    }
    return answers;
  }

  // -------------------------------------------------------------------------
  // paging
  // -------------------------------------------------------------------------

  /**
   * The arguments that continue a paged read, or `undefined` when it is done.
   *
   * `cursor` and `snapshot` are returned TOGETHER or not at all. A cursor sent
   * without its pin is answered against newer state, and the resulting page
   * sequence silently skips and repeats rows — so the pair is produced in one
   * place and a caller never has the opportunity to split it.
   */
  static nextPage(page: AtlasPage): { cursor: string; snapshot: string } | undefined {
    if (!page.has_more) return undefined;
    const cursor = page.cursor;
    const snapshot = page.snapshot;
    if (typeof cursor !== "string" || cursor.length === 0 || typeof snapshot !== "string" || snapshot.length === 0) {
      return undefined;
    }
    return { cursor, snapshot };
  }

  // -------------------------------------------------------------------------
  // one tool call
  // -------------------------------------------------------------------------

  /**
   * Call one tool and hand back its validated result.
   *
   * `Name extends ContractToolName` with the shape table keyed by the same union
   * means an argument object of the wrong shape does not compile, and a result
   * is typed without a cast at the call site.
   */
  async call<Name extends ContractToolName>(
    name: Name,
    args: AtlasToolShapes[Name]["args"]
  ): Promise<AtlasToolShapes[Name]["result"]> {
    const outcome = await this.callRaw(name, args);
    if (outcome.kind === "input-required") {
      throw new AtlasClientError(
        `${name} asked for an owner decision. Call revealSensitive(), which carries the decision through, rather than call().`
      );
    }
    return outcome.structured as AtlasToolShapes[Name]["result"];
  }

  private async callRaw(
    name: ContractToolName,
    args: Record<string, unknown>,
    extra?: { requestState?: string; inputResponses?: Record<string, ElicitationDecision> }
  ): Promise<{ kind: "complete"; structured: Record<string, unknown> } | { kind: "input-required"; escalation: InputRequiredResult }> {
    await this.ensureDiscovered();

    // Validated against the PUBLISHED input schema before anything is sent. A
    // round trip that was always going to be refused wastes an audit event on
    // the server and tells the caller less than this does: the failure names the
    // offending member, here, in the caller's own stack.
    const inputCheck = this.validator.validateToolInput(name, args);
    if (!inputCheck.valid) {
      throw new AtlasContractViolation({ tool: name, direction: "input", errors: inputCheck.errors, document: args });
    }

    const result = await this.send("tools/call", {
      name,
      arguments: args,
      ...(extra?.requestState === undefined ? {} : { requestState: extra.requestState }),
      ...(extra?.inputResponses === undefined ? {} : { inputResponses: extra.inputResponses })
    });

    const resultType = stringMember(result, "resultType");
    if (resultType === "input_required") {
      const escalation = readInputRequests(result);
      if (escalation === undefined) {
        throw new AtlasContractViolation({
          tool: name,
          direction: "output",
          errors: ["resultType is input_required but the result carried no requestState and inputRequests pair"],
          document: result
        });
      }
      return { kind: "input-required", escalation };
    }

    // Strict here and lenient on `server/discover` and `tools/list`, and the
    // asymmetry is deliberate: the whole complete-versus-escalation distinction
    // rides on this field, so guessing `complete` for a missing one would let an
    // escalation be read as an answer. Nothing branches on the field for the
    // other two methods, so demanding it there would buy nothing.
    if (resultType !== undefined && resultType !== "complete") {
      throw new AtlasContractViolation({
        tool: name,
        direction: "output",
        errors: [`unknown resultType ${resultType}`],
        document: result
      });
    }
    if (resultType === undefined) {
      throw new AtlasContractViolation({
        tool: name,
        direction: "output",
        errors: ["the result carried no resultType, which this protocol revision requires"],
        document: result
      });
    }

    const structured = asRecord(result["structuredContent"]);
    if (structured === undefined) {
      // No structured content means the result is not expressible in the tool's
      // own output schema, which on this server is exactly how a typed refusal
      // travels. Anything else is a violation and is reported as one.
      const payload = firstTextPayload(result);
      const refusal = this.asErrorRecord(payload);
      if (refusal !== undefined) throw new AtlasToolRefusal({ tool: name, record: refusal });
      throw new AtlasContractViolation({
        tool: name,
        direction: "output",
        errors: ["the result carried neither structuredContent nor a typed atlas.error:v1 record"],
        document: result
      });
    }

    // Validated even when `isError` is set. An in-contract refusal — a reveal
    // that was declined, for instance — is a full contract payload that happens
    // to be flagged, and it is the shape most likely to drift precisely because
    // it is the one nothing else checks.
    const outputCheck = this.validator.validateToolOutput(name, structured);
    if (!outputCheck.valid) {
      throw new AtlasContractViolation({ tool: name, direction: "output", errors: outputCheck.errors, document: structured });
    }

    return { kind: "complete", structured };
  }

  /** A payload that is a valid `atlas.error:v1`, or undefined. Never a coerced guess. */
  private asErrorRecord(payload: Record<string, unknown> | undefined): AtlasErrorRecord | undefined {
    if (payload === undefined) return undefined;
    const check = this.validator.validateRecord("atlas.error:v1", payload);
    return check.valid ? (payload as unknown as AtlasErrorRecord) : undefined;
  }

  // -------------------------------------------------------------------------
  // one JSON-RPC round trip
  // -------------------------------------------------------------------------

  /**
   * One request, with at most ONE retry, and only for `-32022`.
   *
   * The retry budget is a parameter rather than a comparison of version strings,
   * and that is the whole of the loop safety: `mayRetry` is false on the second
   * attempt whatever the server answers, so no sequence of replies can produce a
   * third. An earlier shape guarded on "did the negotiated revision change",
   * which read as bounded and was not the property that matters — and, with a
   * single-revision client, silently made the retry unreachable.
   *
   * Reachable it must be, because the case it covers is real on a
   * single-revision client too: a proxy that rewrites the `_meta` envelope makes
   * the server refuse a revision it does in fact serve, and names that same
   * revision in `data.supported`. The client's own bytes were correct; one retry
   * is exactly the remedy, and a refusal would send the caller looking for a
   * version mismatch that does not exist.
   */
  private async send(
    method: string,
    params: Record<string, unknown>,
    mayRetry = true
  ): Promise<Record<string, unknown>> {
    const response = await this.dispatch(method, params);

    const error = response.error;
    if (error === undefined) {
      const result = asRecord(response.result);
      if (result === undefined) {
        throw new AtlasProtocolError({ method, code: 0, message: "the response carried neither a result nor an error" });
      }
      return result;
    }

    if (error.code === ProtocolErrorCode.UnsupportedProtocolVersion) {
      const data = asRecord(error.data);
      const supported = Array.isArray(data?.["supported"])
        ? (data["supported"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
        : [];
      const common = supported.find((version) => this.speaks.includes(version));
      if (common === undefined || !mayRetry) {
        // Nothing in common, or the budget is spent. Both sets travel: `supported`
        // alone tells a caller what to try, while `requested` is what lets it tell
        // a revision it chose from a revision something rewrote underneath it.
        throw new AtlasProtocolMismatch({
          ...(stringMember(data, "requested") === undefined ? {} : { requested: stringMember(data, "requested") as string }),
          serverSupports: supported,
          clientSpeaks: this.speaks
        });
      }
      this.negotiated = common;
      return this.send(method, params, false);
    }

    if (error.code === ProtocolErrorCode.MissingRequiredClientCapability) {
      const data = asRecord(error.data);
      const required = asRecord(data?.["requiredCapabilities"]) ?? {};
      const carried = asRecord(data?.["result"]);
      const record = this.asErrorRecord(asRecord(carried?.["error"]));
      throw new AtlasCapabilityRequired({
        tool: stringMember(params, "name") ?? method,
        message: error.message,
        requiredCapabilities: required,
        ...(record === undefined ? {} : { record }),
        ...(carried === undefined ? {} : { result: carried })
      });
    }

    throw new AtlasProtocolError({
      method,
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data })
    });
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params: { ...params, _meta: await this.envelope() }
    };
    return this.transport.request(request);
  }

  /**
   * The `_meta` envelope, rebuilt for EVERY request.
   *
   * Rebuilt rather than cached because both of its interesting members are
   * per-request on this revision: the credential is per-request input, not
   * connection state, and the protocol version can change under negotiation
   * mid-connection. A cached envelope would present a stale credential after a
   * rotation and would keep naming a revision the server just refused.
   */
  private async envelope(): Promise<Record<string, unknown>> {
    const credential = typeof this.credential === "function" ? await this.credential() : this.credential;
    return {
      [PROTOCOL_VERSION_META_KEY]: this.negotiated,
      [CLIENT_CAPABILITIES_META_KEY]: { ...this.declaredCapabilities },
      [CLIENT_INFO_META_KEY]: { ...this.clientInfo },
      ...(credential === undefined || credential.length === 0 ? {} : { [ATLAS_CREDENTIAL_META_KEY]: credential })
    };
  }
}

/** The twelve tool names, re-exported so a caller need not reach past this package. */
export const ATLAS_TOOL_NAMES = CONTRACT_TOOL_NAMES;

export function createAtlasConsumerClient(options: AtlasConsumerClientOptions): AtlasConsumerClient {
  return new AtlasConsumerClient(options);
}
