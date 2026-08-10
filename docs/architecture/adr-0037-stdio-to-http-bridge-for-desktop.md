# ADR 0037: A Stdio-to-HTTP Pipe, Because the Client Cannot Dial a Local Socket

Status: Accepted for implementation
Date: 2026-08-10

Supersedes, in part: ADR 0036's "Rejected alternatives" entry *"A stdio-to-HTTP
bridge Desktop spawns… at the cost of a second protocol implementation to keep
from drifting"*. The cost was real when that was written and ADR 0036 removed it.

## Context

ADR 0035 built one live read-write service on loopback HTTP. ADR 0036 taught it
Claude Desktop's protocol revision, and closed with the claim that Desktop could
now reach it.

That claim was half right, and the half that was wrong is the half that mattered.
ADR 0036 verified the PROTOCOL — a `2025-11-25` handshake is served, a legacy
`tools/call` returns real content. It never verified that Desktop can be
CONFIGURED to point at a loopback HTTP URL, and those are different questions.
Researching the client documentation, and then the owner testing it directly,
established that it cannot:

- `claude_desktop_config.json` defines a **command** — `command`, `args`, `env`.
  There is no URL server type. It spawns processes; it does not dial sockets.
- A **custom connector** takes a URL and requires `https://`, **even for
  `127.0.0.1`**. Confirmed by the owner against the running service.

So the client that needs live editing can spawn a process but cannot dial a local
socket, and the service can be dialled but not spawned. Nothing about the
protocol work was wasted — it is what makes the fix small — but a gap remained
that no amount of protocol conformance closes.

## Decision

A pipe: `packages/atlas-mcp/src/http/bridge.ts`. Claude Desktop spawns it over
stdio; it forwards each JSON-RPC message to the service over HTTP and writes the
answer back.

### It is a pipe, not a second server, and that is the whole point

ADR 0036 rejected a bridge because a second protocol implementation is a second
thing to keep from drifting — precisely the condition the anti-drift gates exist
to prevent. That objection applied to a bridge that would have TRANSLATED between
eras: parsing an opening, minting a modern `_meta` envelope, tracking a session,
reimplementing the ladder.

None of that is needed, **because ADR 0036 taught the service to accept a
2025-era opening directly**. The bridge therefore forwards bytes verbatim and
adds one header. It parses a message only far enough to know whether a reply is
expected. It has no idea what any tool means: the contract, the grant, the audit
and every handler stay in the one service. There is nothing here for the
published surface to drift from — which is why the earlier objection no longer
applies rather than being overridden.

### The two framings it must translate, both measured

Not read from a spec — measured against the running service:

- a REQUEST is answered `text/event-stream`, `event: message` + `data: {…}`.
  stdio frames on newlines and wants one bare JSON object per line, so each
  `data:` payload is re-emitted as its own line.
- a NOTIFICATION is answered `202` with an EMPTY body. Emitting anything for it
  would put a reply on the wire for a message that has no id.

A body that is not SSE passes through unchanged, because the service answers edge
refusals (`-32020`, `-32022`, `401`) as plain JSON and a refusal is exactly the
thing a client must still receive.

### Failures that never reach the service still answer

If the service is down, the port moved, or the bearer is wrong, the bridge writes
a `-32000` JSON-RPC error rather than nothing. Writing nothing would leave the
client waiting forever on a request that can never be answered, which reads as a
hang rather than as a service that is not running.

### Messages are forwarded in order

A client may pipeline and out-of-order answers would be legal JSON-RPC. The
service is a single writer over one store, so serialising here keeps "the order
the client sent" and "the order the graph saw" the same thing — which is what
makes a session transcript reconcilable against the audit log.

### The bearer lives in the Keychain

`run-atlas-bridge.sh` reads it with `security find-generic-password` at spawn
time and passes it in the environment. It is never written into
`claude_desktop_config.json`: that file is plaintext in Application Support, the
client rewrites it on its own schedule, and the bearer can write the only
cleartext copy of the graph — so putting it there would make every backup of that
directory a copy of the credential. A missing Keychain item is a startup failure
with a sentence, not a `401` the client reports as "server disconnected".

## Consequences

- Desktop reaches the live service: one shared store, one writer, edits visible
  to the next query from any client with no restart.
- One more process per Desktop session — a pipe holding no state and no store.
  It is not a second writer and takes no lock.
- The service remains directly usable by anything that CAN dial loopback (Claude
  Code, scripts, future clients). The bridge is for clients that cannot, not a
  new front door.
- ADR 0036's claim that "Desktop can now reach the live service" is corrected
  here: it could speak to it, and could not be pointed at it.

## Rejected alternatives

- **Serve HTTPS on loopback so a custom connector accepts the URL.** Needs a
  certificate the OS trusts, which needs an administrator password this process
  does not have and should not ask for; and it may not help at all, because the
  connector documentation describes remote MCP as internet-hosted and says
  servers behind a firewall will not connect — which suggests the dial happens
  server-side, where `127.0.0.1` is not this machine. Two unknowns and an
  admin-password dependency, against a pipe that is proven working.
- **`mcp-remote` or another third-party proxy.** Same shape, outside this
  repository's gates, and holding the write credential for the only cleartext
  copy of the graph.
- **Wait for a URL server type in the desktop config.** Indefinite, and the owner
  has been unable to edit the graph in place for the whole of this work.
