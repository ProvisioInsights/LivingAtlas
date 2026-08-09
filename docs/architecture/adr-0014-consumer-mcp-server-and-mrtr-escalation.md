# ADR 0014: The Consumer MCP Server, And The MRTR Escalation

Status: Accepted for implementation
Date: 2026-08-04

## Context

ADR 0013 published a 12-tool consumer contract as JSON Schema plus a normative
policy document. Nothing served it. This ADR settles the server that does:
`packages/atlas-mcp`, a stdio MCP server speaking protocol revision 2026-07-28
and nothing else.

Three defects in the prior surface bound the design.

**The refusal string.** A sealed record's read returned the literal string
`cloud-unlock-capability-required`. No error code, no reply channel, no way for
a GUI to ask the owner anything. In a chat client it is a dead end: the user
sees a sentence and has no action.

**The unbounded audit loop.** `localListObjects` called `recordToolDecision`
inside `for (const object of contextObjects(context))` — a whole-graph loop. One
`object_list` call wrote one event per object across two logs, measured at
~58 MiB, and eventually exceeded Node's 512 MiB maximum string length, at which
point the audit log stopped being writable at all. An audit trail that fails
under load is worse than none: the failure looks like an absence of activity.

**Access rules in prose.** AGENTS.md requires access restrictions in tool code.
The prior surface satisfied this unevenly, and the places it did not were not
distinguishable from the places it did.

A fourth constraint came from the SDK, and was found by running it rather than
by reading it — see *Verification*.

## Decision

### 1. Per-request protocol-version negotiation is implemented here, because the SDK does not do it

`@modelcontextprotocol/server@2.0.0`'s `serveStdio({ legacy: 'reject' })` refuses
a 2025-era *opening* — an `initialize`, or any request carrying no `_meta`
envelope — with `-32022`. It does **not** examine the value of
`io.modelcontextprotocol/protocolVersion` once an envelope is present. Measured:
requests naming `2019-01-01`, `2025-06-18`, `2027-01-01`, `not-a-date` and the
empty string were all dispatched and answered as though they had named
`2026-07-28`.

`gateTransport` therefore wraps the transport and refuses, before the SDK sees
the message, any request whose envelope names a revision this server does not
speak. The refusal carries `{supported, requested}` — both members, always.

It is a **transport decorator** and not a request handler because the answer has
to be a JSON-RPC error. A `ProtocolError` thrown inside a tool handler does not
reach the wire as one: `McpServer` flattens any handler throw into
`{isError: true, content: [{text: <message>}]}`, and the numeric code — the only
part a client can branch on — is lost. Also measured.

The no-envelope case is deliberately passed through to the SDK, so one wire
shape has one answer rather than two implementations that can drift.

### 2. One audit event per tool call, enforced by a type rather than by discipline

`ToolContext` carries no audit recorder. A handler **cannot** write an event: it
returns counts, and the dispatcher writes exactly one event. The prior code put
`recordToolDecision` in the handler's hands and a handler put it in a loop.

The size bound is a rule, not a limit:

> **An audit event may name only identifiers that appeared in the REQUEST.
> Everything the graph produced is counted, never listed.**

The request is already bounded by published limits (`max_ids_per_request` = 100,
`max_batch_items` = 100), so an event's size is bounded by the contract rather
than by how much graph a call touched. A full-graph scan and a single-id read
write events of the same order of size.

What is lost is per-object attribution. That is the right trade: *one call read
41,203 records and withheld 812* is the security-relevant fact. *Which 41,203*
is a copy of the graph, and writing a copy of the graph into the audit log on
every read is exactly how the log became unwritable.

Request arguments are covered by a `sha256` digest and do not enter the event.
A text query is frequently the most sensitive string in a request.

### 3. The escalation: `input_required` on the protocol channel, `-32021` on the wire otherwise

`atlas.sensitive.reveal.v1` answers a request for a withheld record by:

- **client declared `elicitation`** — an MCP `resultType: "input_required"`
  result carrying an `elicitation/create` request and a signed `requestState`.
- **client declared no `elicitation`** — the JSON-RPC error `-32021`
  (MissingRequiredClientCapability), whose `data.requiredCapabilities` names the
  missing capability in the `ClientCapabilities` shape.

A server MUST NOT send an inputRequest type the client did not advertise:
issuing an elicitation to a client that cannot answer it is a request nobody
will ever respond to, and the caller waits on it. The refusal names the
capability instead.

**Amended 2026-08-04.** This ADR originally made the second case a *complete*
result marked `isError`, carrying the number in an `atlas.error:v1` field. That
does not satisfy the spec: 2026-07-28 requires a MissingRequiredClientCapability
**error**, and a conformant client branches on the numeric code, which a result
does not carry. Measured: the wire answer was
`{"result":{"structuredContent":{"outcome":"refused",…},"isError":true}}` —
`data.requiredCapabilities` never reached the wire at all.

The receipt argument that produced the original decision still holds and is
satisfied differently: `atlas.sensitive.reveal.v1`'s published output requires
the `audit` block on every outcome "including a refusal", so the whole typed
payload — `atlas.error:v1` record and audit receipt — travels in
`error.data.result`. A consumer has to be told the attempt was recorded; an
audit trail a consumer does not know exists is one it cannot reason about.

Raising it is not a one-line throw, and the reason is worth recording. Three
seams were measured against `@modelcontextprotocol/server@2.0.0`:

- **From the tool handler.** `McpServer`'s built-in `tools/call` wraps input
  validation, the handler and output validation in one try/catch that re-throws
  only `UrlElicitationRequired` and turns everything else into
  `createToolError(message)`. The numeric code is lost.
- **By wrapping the SDK's `tools/call` handler**, the technique already used for
  `tools/list`. This one *appears* to work and quietly breaks the MRTR retry:
  `Server._wrapHandler` verifies and DECODES `requestState` before calling the
  handler it wraps, so a second pass through the same wrapper finds an
  already-decoded payload where it expects the raw string and answers `-32602`
  to every retry. Found by breaking it, not by reading it.
- **At the transport** — where ADR 0014 §1 already produces `-32022`, for the
  same stated reason. The handler parks the refusal under its request id and
  `capabilityRefusalTransport` swaps the outbound result for the error. This is
  the decision.

### 3.1 Who answers the elicitation — stated, because it is not what it looks like

The approval arrives on the **calling client's own channel**. `readElicitationDecision`
reads `context.inputResponses`, which is the caller's reply, so a non-interactive
or scripted MCP client can approve its own disclosure. The disclosure gate is the
calling client's human-in-the-loop, not a server-side control.

What the server *does* enforce, independently of the caller, is listed in §4 and
in the contract's §7.1: integrity, principal binding, method binding, object
binding, TTL, and the durable audit event. The escalation is an owner-decision
*protocol*; whether an owner is actually on the other end of it is the client's
property. Recorded here rather than left implied, because "an owner decision
gates the disclosure" reads as a server guarantee and only part of it is one.
See OPEN-5.

### 4. `requestState` is integrity-protected on BOTH channels

`requestState` round-trips through the client and returns as attacker-controlled
input. The SDK applies none of its own protection and documents that it does
not. Three protections, each covering a different attack:

1. **HMAC-SHA256 over the payload** (`createRequestStateCodec`), verified at the
   SDK seam *before* the handler runs. A forged state never reaches tool code.
2. **Binding to the principal and the method.** A state minted for one
   credential is refused when echoed by another. The binding value is stored as
   a keyed HMAC tag, never raw, so the credential does not appear in the string
   the client holds.
3. **Binding to the object, checked in the handler.** The redaction id is inside
   the signed payload and is compared against the `redaction_id` argument. This
   is the check the `bind` hook cannot make, because `bind` sees the context and
   not the arguments — and without it, a genuine, unexpired, correctly-bound
   state can be pointed at another record.

There are **two** channels a state can arrive on, and this is load-bearing:

- the **protocol** channel, `params.requestState`, which the SDK hook covers;
- the **argument** channel, `arguments.request_state`, a published INPUT field
  the SDK cannot see — to it, an ordinary string.

A verification enforced on one channel and not the other is not enforced. Both
run through the same codec, with the same binding, before the handler.

The payload is a redaction id and a request id and nothing else. The codec is
signed, not encrypted, so the client can read the payload: no key material, no
plaintext, no sensitivity tier goes into it, and none goes into a `_meta`
annotation.

The HMAC key defaults to a per-process random 32 bytes. That is sound *for
stdio specifically*: one process serves every round of a flow. A restart
invalidates outstanding escalations, which is the behaviour we want — an owner
decision spanning a restart should fail closed rather than be honoured by a
process that has forgotten why it was asked. Any multi-instance surface must
supply a shared key; the option exists so that is configuration, not a redesign.

### 5. Every result is validated against its own published output schema before it leaves

The SDK validates too, against the same document, so this is not a second
opinion — it is a second **seam**. An `isError` result is not output-validated by
the SDK, and the reveal refusal path is precisely an `isError` result carrying a
full contract payload. Without the second seam, the one result shape most likely
to drift would be the only one nothing checked.

A result that fails becomes an `output-contract-violation` error rather than
being returned. A consumer that validates would reject it anyway; one that does
not would silently accept a shape nobody published.

### 6. Access decisions live in `access.ts`, called per record

One comparison: a record whose sensitivity rank exceeds the principal's ceiling,
or that the graph marked `withheld`, is replaced by an `atlas.redaction:v1`
stub. Withheld is never *dropped* — the stub occupies the row and the count
reconciles, so a filtered graph is never indistinguishable from a complete one.

An owner-class ceiling does not override `withheld`. A record the graph marked
withheld is unlocked through the reveal path, which writes an audit event, never
through a ceiling high enough to make the mark irrelevant.

Stub ids are `sha256(client_id, record_id)`, truncated. Per-credential, so a
stub issued to one credential does not resolve for another; derived rather than
minted, so no server-side table has to remember which stub went to whom — a
table that can be lost is a reveal that silently stops working; and a hash rather
than the id itself, because an identifier is frequently the sensitive part of a
withheld record.

### 7. `tools.listChanged` is declared FALSE, on both planes

Resolved 2026-08-04. Both servers passed `capabilities: { tools: {} }` and
neither ever sent `notifications/tools/list_changed`. That is not the same as
not advertising it. Measured against `@modelcontextprotocol/server@2.0.0`,
`McpServer.registerTool` runs

```
registerCapabilities({ tools: { listChanged: getCapabilities().tools?.listChanged ?? true } })
```

so an absent bit became an advertised `true`, and `server/discover` answered
`{"tools":{"listChanged":true}}`. The existing assertion used `toMatchObject`,
which accepts extra members, so nothing caught it.

The claim had consequences rather than being cosmetic. The SDK activates a
client's list-changed handler only when the server advertises the bit, and
`honoredSubset` acknowledges a client's `toolsListChanged` subscription against
that same bit — the acknowledgement is documented as reflecting "what the server
can actually deliver". This server was therefore acknowledging a subscription it
would never satisfy, and a client trusting the acknowledgement would wait for a
push instead of re-reading `tools/list`.

**Declared false rather than wired**, because there is nothing coherent to send.
`tools/list` here is a pure function of the credential presented on the REQUEST
(§ADR 0015), so there is no connection-scoped tool list that could change. A
stdio pipe may carry several credentials. A notification is addressed to the
CONNECTION and names no credential, so firing one when some grant was revised
would (a) disclose to whoever holds the pipe that another principal's grant
moved, and (b) be exactly the tool set varying "as a side effect of other
requests on the connection", which the specification forbids in the same
paragraph that permits varying by the authorization presented.

The operator plane is where a push would be most tempting, since an operator's
tool set moves when a grant is revised — and most harmful, since the event a
notification would carry is "somebody's grant was just edited". `tools/list`'s
cache TTL bounds how long a revision goes unnoticed without telling one
credential about another, and `atlas.scope.describe.v1` answers for the
credential that asked.

Tested on both planes: the advertised bit is asserted `false` *exactly* rather
than with `toMatchObject`, and a sequence that returns two different tool sets
over one connection is asserted to emit no notification at all.

## The forks resolved here

**`outcome: "input-required"` needed a reachable path.** The contract publishes
that member and an `input_request` block, but an MCP `InputRequiredResult`
cannot carry `structuredContent` — so the protocol channel physically cannot
express it. The spec is also explicit that a server MUST NOT assume the client
will ever retry. Resolved with `revealEscalationInBand`, default **false** (the
required protocol-channel behaviour). Set true, the same signed state is returned
as a complete result, and the caller re-calls the tool with `request_state` as an
argument — a second channel needing no protocol support, which is why that field
is in the published input schema at all. Both forms mint the same state, bind it
the same way, and write the same single audit event.

**Coverage counts are bucketed below the owner tier, and rounded UP.** Exact
counts are a disclosure channel: repeated filter bisection against an exact
`withheld` localises a withheld record without ever reading it. Rounding down
could report `withheld: 0` when something was withheld, which is the one lie
this surface must never tell. Zero stays zero — "nothing was withheld" is a true
statement worth being able to make. `returned` is never bucketed: it is the
length of an array the caller is holding, and rounding it would make the result
contradict itself.

**A paging cursor without its snapshot is refused, not served.** Serving it
computes the later page against newer state, so the sequence skips and repeats
rows — and the consumer cannot detect that it happened. Expiry is likewise a
typed refusal naming the restart, never a fallback to fresh state.

**The error-code vocabulary is published and enforced.** `atlas.error:v1`'s
`code` is open, because a consumer that breaks on an unfamiliar code breaks when
Atlas becomes more honest. Open is not undocumented: `vocabulary.ts` registers
every code with an origin, retryability and a summary, and a test reads the
handler sources and fails if any emitted code is unregistered.

**`atlas-core` gained two read-only accessors.** `readSubmission(client_id,
idempotency_key)` and `readSubmissionById()`. The contract publishes
`atlas.submission.read.v1` for the case that matters — a connection dropped
after a proposal and the caller does not know whether it committed — and the
store had no way to answer without risking a second copy through `commit()`.
`readSubmissionById` is deliberately **not** credential-scoped: that layer has no
notion of a credential, and inventing one would put the same access rule in two
places. The scope check is in the tool, against the `client_id` the receipt
carries.

**The SDK's default schema provider cannot serve this contract.** It compiles
each schema alone, so a `$ref` into another published document does not resolve;
registering `atlas.contract.describe.v1` fails at compile time and every call to
every tool answers `-32603`. Inlining the refs would make the server validate
against bytes no consumer ever fetched — the schema-in-two-places defect the
contract package exists to prevent. Resolved by handing the SDK the
already-compiled `ContractValidator` through the `jsonSchemaValidator` interface,
so the SDK's input check and this package's output check run the *same* compiled
function and cannot disagree.

## Open questions

- **OPEN-1: the principal source.** `PrincipalResolver` is a port and the stdio
  binary supplies a fixed consumer principal. What resolves a credential into a
  principal on stdio — and whether three clients over one stdio pipe are three
  principals — is not decided here.
- **OPEN-2: bucket width.** 10 is a placeholder. The width that actually defeats
  bisection depends on the graph's size and on how many queries a credential may
  issue, and neither is measured yet.
- **OPEN-3: `disclosure_level` policy.** The gap-based rule (≤1 rank above the
  ceiling reveals the record kind; further reveals only existence) is a
  defensible default, not an evidenced one.
- **~~OPEN-4: audit durability.~~ RESOLVED 2026-08-04: yes, and for every event,
  not only disclosures.** The port now specifies that `append` returns only once
  the event would survive a crash, and `DurableFileAuditJournal`
  (`audit-file.ts`) implements it with `SegmentWriter.appendGroup`'s discipline —
  one open handle, `writeSync` then `fsyncSync`, return after the sync. Both CLIs
  use it in place of `appendFileSync`, which returned once the bytes reached the
  page cache and so could lose an event *after* the disclosure it recorded had
  been returned: a surviving graph that was read and a log that says it was not,
  the one direction the discrepancy must never point.

  Applied uniformly rather than to reveals alone. A journal durable only for the
  calls someone remembered to mark has a guarantee nobody can state, and uniform
  durability means the reveal path needs no special case — it inherits the
  property from the port. The cost is one fsync per tool call.

  The ordering half was already correct (the dispatcher writes before it builds
  the result). What is new is the failure half: an implementation that cannot
  make the event durable MUST throw, and the dispatcher turns that into a failed
  call, so a disclosure whose event could not be written never reaches the
  caller. Tested both ways — a refusing journal yields no record and no
  escalation state on either the protocol or the in-band path, and the happy
  path's receipt names an event already in the journal.
- **OPEN-5: an owner channel independent of the requesting client.** §3.1: the
  elicitation answer comes back on the caller's own channel, so the disclosure
  gate is the client's human-in-the-loop. Whether a disclosure should instead
  require an out-of-band owner channel is undecided, and the cost of deciding
  yes is that no single-process client could complete a reveal on its own.
  Mirrored as OPEN-9 in the published contract.

## Consequences

> **Superseded in part by ADR 0034 (2026-08-06).** The two bullets about the 2025
> era below were written on the belief that Claude Desktop negotiates 2026-07-28
> on the wire. It does not — it opens with an `initialize` at 2025-11-25, verified
> from the server's own stderr — so under this decision Claude Desktop was
> refused, the opposite of the first bullet's claim. ADR 0034 admits a transitional
> 2025-11-25 legacy opening. The per-request value gate of Decision 1 is unchanged
> and still in force; what changed is that the no-envelope opening is no longer
> uniformly refused. The bullets are left here as written rather than edited,
> because the falsified premise is the useful record.

- Claude Desktop connects. Claude Code 2.1.191 and Codex 0.142.1 are legacy and
  will not, until they update. Accepted, and deliberately not designed around.
- A withheld record in a GUI now produces an owner prompt instead of a sentence.
- The audit log's size is bounded by published request limits rather than by
  graph size.
- A consumer can discover its own scope (`atlas.scope.describe.v1`) rather than
  inferring it from refusals.
- The 2025 era is unreachable through this server by two independent mechanisms,
  so removing either still refuses.

## Rejected alternatives

**Enforce the version check inside each tool handler.** A `ProtocolError` thrown
from a handler is flattened to `{isError, content}` and its code is lost, so the
refusal would be untypable — and `server/discover` and `tools/list` are not tool
handlers at all, so they would go unchecked.

**Inline every `$ref` before registration.** Makes the served schemas different
bytes from the published ones. The published contract exists so that what a
consumer fetched and what the server validates against are the same document.

**Return the reveal refusal as a bare tool error.** Throws away the audit
receipt the tool's own published output requires on every outcome.

**Keep `recordToolDecision`'s per-object granularity but cap the log.** A cap
makes the log silently incomplete under exactly the load where it matters most.
Counting is complete at every scale.

## Implementation

`packages/atlas-mcp/src/`: `protocol-gate.ts`, `principal.ts`, `access.ts`,
`audit.ts`, `reveal-state.ts`, `vocabulary.ts`, `graph.ts`, `results.ts`,
`schema-provider.ts`, `tool-context.ts`, `tools.ts`, `server.ts`, `stdio.ts`,
`cli.ts`, `testing.ts`.

Modified: `packages/atlas-core/src/store.ts` — `readSubmission`,
`readSubmissionById`.

## Verification

`protocol.test.ts`, `reveal.test.ts`, `audit.test.ts`, `access.test.ts`,
`tools.test.ts`, `vocabulary.test.ts`. Twelve mutations were applied to the
implementation one at a time and each was caught by its intended test — among
them: the gate ignoring the envelope's version value; the `requestState.verify`
hook removed; the object-binding check removed; the in-band `request_state`
accepted without verification; the audit written per record; a withheld record
dropped instead of stubbed; the elicitation capability check removed; cacheable
results marked `public`; and the supersession scope not enforced.

Every fixture is synthetic and in memory. No test in this package reads a real
graph, a profile directory, or any path outside the repository.
