# ADR 0034: A Transitional Legacy Protocol Era for the Stdio Server

Status: Accepted for implementation
Date: 2026-08-06

Supersedes, in part: ADR 0014 (the two Consequences bullets asserting the 2025
era is unreachable and that Claude Desktop connects on the modern revision).

## Context

The owner's migrated store is live and readable by design, and no client could
reach it. The failure was on the wire, in the server's own stderr, not inferred:

```
[atlas-mcp] Rejected 2025-era request on a modern-only stdio connection
(modern-only-missing-envelope): Unsupported protocol version: 2025-11-25
```

Claude Desktop 1.26832.0 — the newest build, whose bundle contains 2026-07-28
code — opens its stdio connection with an `initialize` at protocol revision
**2025-11-25**. On the wire it negotiates the legacy revision regardless of the
code it ships. ADR 0014 chose "no legacy era, no dual era" on the belief that
Desktop speaks 2026-07-28. That premise is falsified: under it, the newest
Desktop is refused, which is the opposite of what ADR 0014's first Consequences
bullet claimed.

The owner has decided to enable a transitional legacy era.

## The two layers, and what each actually did

Established by running `@modelcontextprotocol/server@2.0.0`, not by reading it:

1. **`serveStdio`'s `legacy` mode.** With `legacy: 'reject'` it refuses any
   2025-era opening — an `initialize` without a valid modern `_meta` envelope, or
   any envelope-less request — with `-32022`. This, and this alone, produced the
   wire rejection above. With `legacy: 'serve'` it connects a legacy-era McpServer
   and pins the connection to it.

2. **The custom `gateTransport`.** It refuses a request whose `_meta` envelope
   *names* an unsupported revision — the value check the SDK does not perform. It
   did **not** reject the legacy opening: an `initialize` carries its version in
   `params.protocolVersion`, not in `_meta`, so the gate saw `requested ===
   undefined` and passed it straight through. Verified in-process against the
   composed transports.

This corrects the framing that led into the task. The custom gate never
independently rejected the legacy opening; both rejections were the SDK's
`legacy:'reject'`. So the work was not "stop the gate rejecting" — it was the
opposite, and the reason follows.

## Decision

### 1. One switch, read by both layers

`SUPPORTED_LEGACY_PROTOCOL_VERSIONS` in `packages/atlas-mcp/src/stdio.ts` is the
single place the era is decided. `["2025-11-25"]` today; `[]` at sunset.

- `serveStdio` runs `legacy: 'serve'` when the list is non-empty, `'reject'` when
  empty.
- `gateTransport` is given the same list and admits exactly those legacy openings.

Emptying the list reverts the whole change to the original modern-only server, in
one edit. That is the greppable sunset switch this ADR promises.

### 2. The gate NARROWS the era; the SDK cannot

`legacy: 'serve'` admits *any* 2025-era `initialize` — the SDK classifies by "does
this carry a valid modern envelope", never by which legacy revision the opening
names. Left to the SDK alone, turning the era on would serve 2025-06-18 and a
garbage version string alike. The requirement is that the door opens for
2025-11-25 and nothing else, so the gate refuses every legacy `initialize` whose
`params.protocolVersion` is not in the admitted list — before the SDK can pin a
connection to it. A rejected legacy opening is told both revisions the server
accepts, so a legacy-capable client learns it can fall back to 2025-11-25.

### 3. The gate now owns the no-envelope refusal, because the SDK stopped giving it

This is the subtlety that makes the change more than a flag flip.

`legacy: 'serve'` classifies **any** envelope-less opening as legacy — including a
MODERN client that dropped its envelope. Under `legacy: 'reject'` that client got
`-32022` telling it to fix its envelope; under `legacy: 'serve'` the SDK would
instead route it to a legacy McpServer that does not understand `server/discover`
and answers a confusing method-not-found. That silently degrades the modern error
path, which must stay exactly as it was.

So when the era is on, the gate refuses an envelope-less request that is neither an
admitted legacy `initialize` nor part of an established legacy session — the
modern no-envelope answer is `-32022`, exactly as before the era existed. This
requires the gate to know one fact it cannot read off a single message: whether a
legacy handshake has happened on this connection. An envelope-less request means
"modern client, fix your envelope" before a legacy opening and "the legacy
session's own traffic" after one, and those need opposite answers.

`gateTransport` therefore latches `legacyEstablished` when it passes an admitted
legacy `initialize` (the decision carries `establishesLegacy`), and passes the
context to the otherwise-pure `gateInbound`. One `gateTransport` wraps one
connection, so the state cannot leak between clients.

When the era is **off**, this whole branch collapses: the gate adds nothing to the
no-envelope case and the SDK's `legacy:'reject'` answers it, which is ADR 0014's
"one wire shape, one answer" unchanged. The distinction only exists while the era
is on, because only then does the SDK stop refusing the shape itself.

### 4. Reads work over legacy; the in-band reveal does not

A 2025-11-25 client presents its credential in `_meta` exactly as a modern client
does — what it omits is the protocol-version and capability envelope keys. Reading
local-private content needs nothing more, and the e2e proof reads seeded content
back over the legacy handshake.

The in-band MRTR reveal is different: it needs the modern envelope and the
elicitation capability, which a legacy connection does not carry. Over legacy it
falls to the documented `-32021` capability refusal. This ADR does not pretend
reveal works both ways — it does not, and it does not need to, because reveal is a
disclosure escalation and not a read of local-private content. The owner reading
their own graph is unaffected.

## Scope

Stdio only. Claude Desktop connects over stdio; the change is confined to
`serveAtlasStdio` and the gate it wires. The HTTP entry (ADR 0019) keeps
`legacy: 'reject'` and is untouched. Widening HTTP is a separate decision with its
own transport conformance surface, and nothing in this task needs it.

## Verification

- **The proof that counts** (`packages/atlas-e2e/src/legacy-opening.e2e.test.ts`):
  a raw client opens the real shipped server with a 2025-11-25 `initialize`, and
  reads seeded `Synthetic Employer` content back through a `tools/call`. It speaks
  raw JSON-RPC because `AtlasConsumerClient` only speaks 2026-07-28 — the whole
  failure is invisible to a suite that cannot open the legacy way.
- The same file proves a 2025-06-18 opening is still refused on the real wire.
- The existing modern e2e scenarios stay green, proving the modern path is
  untouched.
- Gate-unit coverage in `protocol.test.ts` pins: an admitted opening passes and
  latches; every non-admitted legacy version rejects; a non-string version
  rejects; established-session traffic passes; the same traffic is refused before
  a session exists; and with the era off the opening is passed to the SDK as
  before.

## Sunset

Transitional by construction. The condition to remove it: clients open without a
legacy `initialize` — i.e. Claude Desktop negotiates 2026-07-28 on the wire.

Removal is one edit: set `SUPPORTED_LEGACY_PROTOCOL_VERSIONS` to `[]`. The SDK
reverts to `legacy:'reject'`, the gate stops admitting any legacy opening and
stops owning the no-envelope refusal, and the server is modern-only again. Do not
let "transitional" become permanent by being undocumented: this paragraph and the
constant's own comment are the record of the condition.

## Rejected alternatives

- **Flip `legacy: 'reject'` to `'serve'` and stop.** Serves 2025-06-18 and a
  garbage version string as legacy, and silently routes a modern client's
  envelope mistake to a legacy McpServer. Fails "the door opens for 2025-11-25,
  not for anything" and "the modern path stays exactly as it is".
- **A stateless gate.** Cannot tell an established legacy session's envelope-less
  tool call from a modern client's dropped envelope; one reading breaks legacy
  reads, the other degrades the modern error path. The single latched bit is the
  minimum state that separates them.
- **Widen HTTP too.** Out of scope; Desktop is stdio, and HTTP has its own
  conformance surface to re-verify.
