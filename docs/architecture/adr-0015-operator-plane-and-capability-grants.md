# ADR 0015: The Operator Plane, And Capability-Grant Credentials

Status: Accepted for implementation
Date: 2026-08-04

## Context

ADR 0014 built the consumer MCP server. It left three things unresolved, and they
turn out to be one thing.

**Operational concerns had nowhere to live.** Migration windows, replication and
sync state, usage and billing reconciliation, the curation queue, reconcile, and
the audit read path are not consumer questions. Published on the consumer
contract they would tell every integrator what a deployment's operational
posture is; omitted entirely they have no surface at all.

**A credential was its transport.** `McpProfile` in `packages/contracts` is
literally a list of transports — `local-full`, `local-readonly`, `local-crud`,
`local-admin`, `local-release`, `remote-safe`, `remote-cloud-unlock`,
`sensitive-keyholding-client`, `sync-device` — and `authenticateLocalMcp` refused
any capability whose profile was not in the `local-*` set. Two consequences, and
the second is the expensive one:

- transport parity was unreachable *by construction*. "The same client, the same
  permissions, over a different wire" was not expressible, so no test could
  compare two surfaces and every difference between them was invisible rather
  than declared;
- a correct consumer had to know which transport it was on to know what it could
  do, which puts an authorization decision in the caller.

**Attribution was impossible.** The prior daemon read whatever credential
arrived and then substituted its own environment token before doing anything
with it. Every consumer committed under one identity, so `provenance.client_id`
named the daemon rather than the caller — and the supersession rule, which is
written in terms of *assertions this credential authored*, could not be
evaluated against anything real.

ADR 0014's **OPEN-1** ("what resolves a credential into a principal") is the
question all three of these are asking. This ADR answers it.

## Decision

### 1. A credential resolves to a `{principal, grant}` pair, and nothing in it names a wire

```
Principal  = { client_id, credential_class, plane, grant }
Grant      = { sensitivity_reachable[], tools_permitted[], predicates_writable[],
               write_tiers_permitted[], limits{},
               coverage_counts_basis, supersession_scope, reveal_available }
```

The split is the point. The principal says *who* is calling and on which plane;
the grant says *what may be done*. There is no field in either where a transport
could go, and `grant.test.ts` scans the authorization modules — with comments and
prose strings removed — and fails if a transport word appears in one. The
stripper is itself tested against vacuity: the same files' *comments* must still
mention transports, or the scan is deleting everything.

Differences between deployments are discovered generically:
`atlas.scope.describe.v1` now publishes the whole grant — `grant_id`,
`tools_available`, `sensitivity_reachable`, `sensitivity_ceiling`,
`predicates_writable`, `write_tiers_permitted`, and the effective `limits`.

### 2. Sensitivity reach is a NAMED SET, not a threshold

`sensitivity_reachable` is a set of tiers by name, and `access.ts` decides by
membership. `sensitivity_ceiling` survives — the published contract requires it
and the redaction stub's `disclosure_level` is sized from the rank gap — but it
is now a *report* of the set rather than the rule, derived by one function so the
two cannot disagree.

A threshold admits any tier that happens to sort below it, **including one
introduced after the grant was written and ranked low by whoever introduced it**.
A named set cannot widen without someone editing a grant. This is the one
behavioural change to an existing rule, and it is strictly more conservative: a
record whose tier a grant does not name is withheld even when its rank is far
below the ceiling.

### 3. A grant narrows a published limit and can never widen one

`effectiveLimit(published, granted)` is `Math.min`, with one reader, and the
result is both enforced (`resolvePageSize`) and published
(`atlas.scope.describe.v1`'s `limits`). A parse-time refusal of an over-large
grant was rejected as a *second* rule that could disagree with the first.

The old surface's defect was two numbers for one limit — `LocalBatchMaxItems`
100 against `RemoteBatchMaxItems` 10 — with no way for a caller to discover
which applied. A grant that narrows is legitimate; a narrowing a caller cannot
read back is that same defect with a new name.

### 4. Identity is per-request input, and the resolver is the only source of `client_id`

`PrincipalResolver` takes the credential **presented on the request**. That is
what the protocol makes available: MCP 2026-07-28 has no session, and the tool
set a server answers with may vary by the authorization presented *because*
credentials are per-request input rather than connection state. A resolver
taking no argument can only ever answer with one principal per process, which is
exactly the collapse being fixed.

The credential rides `_meta` under `io.livingatlas/credential` — not a tool
argument, because an argument would have to appear in the published input schema
of every tool, which puts a secret into the object that gets logged, echoed in
error messages, and digested into the audit event's `arguments_digest`.

`provenance.client_id` is set from the resolved principal. There is no code path
that replaces a caller's credential with the server's own.

### 5. The operator plane is a separate server, and two independent mechanisms keep it separate

`packages/atlas-mcp/src/operator/` builds its own `McpServer`, with
`serverInfo.name = "living-atlas-operator"`, over seven tools: scope describe,
migration window read, replication status read, usage reconcile read, review
queue read, reconcile run, audit read. Removing either mechanism below still
separates the planes.

1. **Different servers.** The consumer dispatch table is
   `Record<ContractToolName, ToolHandler>` — total over the published twelve —
   so an operator tool is not *expressible* there. Nothing in the consumer tree
   imports the operator tree.
2. **Different credentials.** `credentialResolver` is built for a plane and
   refuses a credential granted another; `PrincipalSchema` refuses a principal
   whose plane and credential class disagree, in both directions. A consumer
   credential presented to the operator server never reaches a handler and sees
   an empty `tools/list`.

Varying `tools/list` by the presented authorization is explicitly permitted. From
the specification, *server/tools* §Capabilities:

> Servers that declare the `tools` capability **MUST** respond to `tools/list`
> requests with the set of tools currently available to the requesting client.
> This set **MAY** be empty and **MAY** change over time …, but **MUST NOT** vary
> per-connection or as a side effect of other requests on the connection. The set
> **MAY** vary by the authorization presented on the request — for example,
> returning only the tools the caller's granted scopes permit — since credentials
> are per-request input, not connection state.

The same paragraph that permits the filter forbids the other thing, which is why
both servers read the credential off the *request* and never off the connection.

### 6. An unresolved credential gets an empty list, and a named refusal on a call

`tools/list` answers `{tools: []}`; `tools/call` refuses. Two behaviours for one
condition, on purpose: "you may call nothing here" is the honest and least
informative answer to a listing, and the spec allows an empty set. A *call* has
to say why, or the caller cannot act.

The wire refusal is **one code for every cause** — `credential-unrecognised`.
Distinguishing "unknown secret" from "known secret, wrong plane" tells a prober
that a secret it holds is real, which is the more useful half. The audit event
carries the precise cause (`credential-unknown` / `credential-plane-mismatch`);
the wire does not.

### 7. The audit read path counts subjects and never lists them

An audit event's `subjects` are identifiers the *caller* named, and a great many
of them are graph identifiers. Returning them would make the operator plane a
second read path into the graph with none of the sensitivity machinery applied
to it. `atlas.ops.audit.read.v1` returns `subjects_count` and accepts a
`subject_id` **filter**: an operator can ask "did this credential touch this id"
without enumerating everything it touched.

### 8. One audit event per operator call, and the plane is on the event

The operator dispatcher writes exactly one event per call, and `OperatorContext`
carries no recorder — the same structural rule as ADR 0014 §2, for the same
reason. `AuditEvent` gains `plane` and `grant_id`, and `client_id` /
`credential_class` / `grant_id` become nullable so a *refused* credential is
still an event. A server that logs only successful authentications reports an
attack as silence. `null` rather than a sentinel string, because a sentinel is a
name a real credential could also be given.

## What the SDK actually does — measured, not read

Two findings, both against `@modelcontextprotocol/server@2.0.0`, both of which
changed the implementation.

**Only reserved `_meta` keys reach `ctx.mcpReq.envelope`.** The inbound lift
moves the `io.modelcontextprotocol/*` keys into `envelope` and leaves every other
`_meta` member in `ctx.mcpReq._meta`. A project-namespaced credential read off
`envelope` finds nothing — and finding nothing is indistinguishable from a caller
that presented nothing, so the server fails closed for the wrong reason with a
refusal nobody can act on. `presentedCredential` reads `mcpReq._meta`.

**`tools/list` can only be filtered by overriding after registration.**
`McpServer` installs its own `tools/list` handler lazily on the first
`registerTool`, guarding with `assertCanSetRequestHandler` — so a handler
installed *first* makes `registerTool` throw. `Server.setRequestHandler` itself
does not assert; it overwrites. Register first, override second is the only order
that works, and the override still passes through `_wrapHandler`, so the
configured `ttlMs`/`cacheScope` are still attached. The consumer override also
emits the *published* schema documents rather than the SDK's re-serialization of
what it compiled.

## The forks resolved here

**The operator plane is not a published, fetchable contract.** Its schemas are
zod, validated on the way out but not advertised. The consumer contract exists so
a third party can fetch it and hold the server to it; the operator plane is the
owner's own control surface, and publishing a catalogue of a deployment's
operational tools is a disclosure with no matching benefit. Reversible: the
catalogue-and-manifest machinery in `packages/atlas-contract` is plane-agnostic.

**The operator plane has its own error-code registry.** Published through
`atlas.ops.scope.describe.v1`, because this plane has no `contract.describe`. A
test asserts no operator-only code appears in the consumer registry — that
listing is served to every consumer and would otherwise disclose which
operational tools exist and how they fail. It is the same line
`packages/atlas-contract/src/parity.test.ts` already holds for atlas-core's
identity-decision refusals.

**Discovery tools are reachable regardless of `tools_permitted`,** per plane. A
credential that cannot ask what it may do can only learn by probing, and probing
is the behaviour `atlas.scope.describe.v1` exists to remove. Withholding the
answer protects nothing; it only makes the refusals harder to interpret. The
operator plane's discovery tool is *not* inherited by a consumer grant — the set
is keyed by plane, not shared.

**`atlas.scope.describe.v1`'s published output grew five members** (`grant_id`,
`sensitivity_reachable`, `predicates_writable`, `write_tiers_permitted`,
`limits`), all required. "Discovered generically through
`atlas.scope.describe.v1`" is only true if the tool actually publishes the grant.
Pre-cutover and additive: `prior_versions_retained_before_cutover` is 0, so there
is no consumer holding the older shape.

**`write_tiers_permitted` is enforced against the tier that will be WRITTEN.**
The published input carries no tier, so `commit` stamps its default (`open`) and
the check is against that constant, named in one place. Checking a caller-supplied
value would be checking a field no caller can send; the refusal is in place for
the revision that lets one.

**`reconcile` defaults to `dry_run: true`.** The default of a mutating
operational tool is the one that changes nothing. `dry_run` is a parameter of the
*port*, not something the server simulates, because only the store knows what
applying would change — a preview computed here would describe an operation this
server did not perform.

## Open questions

- **OPEN-1 (from ADR 0014) is now closed.** A credential is presented per request
  and resolved against a directory; the stdio CLI without a directory says on
  stderr that it attributes everything to one `client_id`.
- **OPEN-5: credential transport binding.** On stdio the pipe is the trust
  boundary and the `_meta` credential distinguishes consumers that already share
  it. On HTTP the credential must come from `ctx.http.authInfo`, and whether the
  `_meta` channel should then be *refused* rather than merely unused is not
  decided here.
- **OPEN-6: credential lifecycle.** The directory has no revocation, rotation, or
  expiry. `LocalCredentialRecord` in `packages/contracts` has all three and is
  the obvious source; wiring it is out of scope for this run.
- **OPEN-7: `subjects` in the audit read path.** Counted, never listed, and
  `subject_id` filters. Whether an operator investigation ever legitimately needs
  the list — and what would authorize it — is unresolved. The conservative
  default is deliberate.
- **OPEN-8: the legacy profile model still exists.** `McpProfileValues` and
  `LocalMcpAllowedProfiles` remain in `packages/contracts` and
  `packages/local-mcp`, which the rewrite plan retires. Nothing in the new stack
  reads them; they were deliberately not rewritten here, because the value of
  this change is that the *new* plane cannot inherit the defect.

## Consequences

- Two consumers over one pipe are two `client_id`s, and a usage report has two
  rows. A deployment that collapses them reports one row, and that row *is* the
  signal.
- A consumer that branches on its transport is now wrong by contract [C-40], not
  merely unfashionable.
- Operational tooling has a surface, and it is one a consumer credential cannot
  see, list, or call.
- The audit journal is shared by both planes, so every event has to say which
  plane wrote it. It now does.
- A record at a tier nobody granted is withheld even when its rank is low. This
  is a behaviour change and it fails closed.

## Rejected alternatives

**Put the operator tools behind a flag on the consumer server.** The tool set
would then vary by server configuration rather than by presented authorization,
which is the thing the revision forbids ("MUST NOT vary per-connection"), and a
misconfiguration would be a silent privilege rather than a refused credential.

**Keep `sensitivity_ceiling` as the rule and add the set alongside it.** Two
rules for one decision. The one that is wrong is always the one nobody reads.

**Refuse an over-large grant limit at parse time.** A second rule that can
disagree with `effectiveLimit`. One rule, one reader.

**Return `subjects` from the audit read path and rely on the operator credential
being trusted.** An operator credential is a credential, not an exemption. The
sensitivity machinery governs graph identifiers wherever they flow.

**Carry the credential as a tool argument.** It would appear in the published
input schema of every tool, in logged arguments, in error messages, and in the
audit event's arguments digest.

## Implementation

New: `packages/atlas-mcp/src/grant.ts`, `credentials.ts`, and
`packages/atlas-mcp/src/operator/` (`source.ts`, `vocabulary.ts`, `tools.ts`,
`server.ts`, `stdio.ts`, `testing.ts`, `cli.ts`, `index.ts`).

Modified: `principal.ts`, `access.ts`, `results.ts`, `audit.ts`, `server.ts`,
`tools.ts`, `reveal-state.ts`, `testing.ts`, `cli.ts`, `index.ts`,
`vocabulary.ts`, `package.json`; `packages/atlas-contract/src/catalog.ts` and the
regenerated `schema/2026.08.0/`; `docs/contract/atlas-knowledge-contract-2026.08.0.md`
(§8.1, C-40, C-41).

## Verification

`packages/atlas-mcp/src/grant.test.ts` and
`packages/atlas-mcp/src/operator/operator.test.ts`. Sixteen mutations were applied
one at a time and each was caught by its intended test — among them: the
`tools/list` filter removed; the tool-permission gate removed; the plane check
removed from the resolver; tier reachability reverted to admitting anything; a
grant allowed to widen a published cap; the credential no longer read off the
request; `predicates_writable` and `write_tiers_permitted` unenforced; the
plane/credential-class binding removed; a transport string introduced into an
authorization decision; the operator `tools/list` served to an unresolved
credential; the operator audit written twice per call; the audit read path listing
the subjects it counted; `reconcile` defaulting to applying; usage collapsing
every credential onto one row; and the review queue dropping its withheld mark.

Every fixture is synthetic and in memory. No test in this package reads a real
graph, a profile directory, a deployment's operational state, or any path outside
the repository.
