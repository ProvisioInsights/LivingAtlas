# @living-atlas/atlas-e2e

**A test harness. Not a product surface.**

It declares no `exports`, so nothing outside this package can import it, and it
publishes no binary. If you are looking for something to run in a deployment, you
are in the wrong package: `packages/atlas-mcp` is the server and
`packages/atlas-client` is the client.

## What it proves

The suite spawns the **real** consumer server as a child process against a fresh
temporary data directory and drives it through the **real** typed client. Nothing
on the request path is mocked, stubbed, or reimplemented for the test: the shipped
`serveAtlasStdio` entry, the shipped twelve handlers, the published schemas on
both sides, the protocol gate, the capability-refusal transport, and atlas-core's
own segment log.

The journey, asserted step by step:

| Step | Scenario | File |
|---|---|---|
| 1–2 | `server/discover`, then `atlas.contract.describe.v1` with an honest history block (`prior_versions_retained_before_cutover: 0`) | `journey.e2e.test.ts` |
| 3–4 | A governed write, its receipt, and an idempotent retry that replays the original receipt and mints no new seq | `journey.e2e.test.ts` |
| 5 | Both time axes, including an as-of-before-floor refusal and unknown world time matching nothing | `journey.e2e.test.ts` |
| 6 | The change feed, resumed from a cursor with no skip and no repeat | `change-feed.e2e.test.ts` |
| 7–9 | `atlas.sensitive.reveal.v1`: refusal without the elicitation capability, approval with it, and a tampered `requestState` rejected | `reveal.e2e.test.ts` |
| 10 | **SIGKILL the server, restart on the same data**: same answers, cursor resumes, the retry still replays the original receipt | `restart.e2e.test.ts` |
| 11–12 | The operator plane is invisible to a consumer credential, and an operator credential never reaches a handler | `plane-isolation.e2e.test.ts` |
| 13 | **The SHIPPED binary, pointed at a store that already exists**: reads back what atlas-core wrote, survives SIGKILL and restart on the same directory, refuses a proposal read-only, still serves the empty in-memory graph with the variable unset, and EXITS rather than serving an empty graph when the directory is not there | `serve-store.e2e.test.ts` |

Each scenario is an independent test. A scenario that **writes** — a proposal, a
restart — takes its own temporary directory and its own server process, because
the change feed's seq and the idempotency table are exactly the state a later test
would otherwise depend on. A scenario that only **reads** shares one per file, and
its audit assertions are deltas (`workspace.auditSince(marker)`) rather than
totals — which is the invariant that was always meant: *this call* wrote exactly
one event.

Different credentials need no separate server. Credentials are per-request input
on this revision, so one process serves the consumer, the operator and the
anonymous caller in `plane-isolation.e2e.test.ts` — which demonstrates the point
better than three processes each seeing one credential would.

## It runs inside `npm test`

The files match the repository's vitest include (`packages/**/*.test.ts`) and are
named `*.e2e.test.ts` so a reader of a failure knows immediately that a real
process was involved. The whole suite is a few seconds and spawns twenty child
processes: the synthetic fixture is two entities and five assertions.

If you add a scenario, take a private server only if it writes. Twenty spawns is
not an arbitrary budget — an earlier version at thirty-four reliably tipped an
existing CPU-bound test elsewhere in the repository over its timeout.

Step 13 is the exception to "share a server for reads": every one of its
scenarios needs its own process, because what it varies IS the environment the
process was started with.

## Privacy

Everything is fabricated and everything lives under `os.tmpdir()`. The fixture
server (`server-entry.ts`) reads **nothing** outside the directory it is told to
use: no environment fallback, no profile lookup, no default path. A missing
`--data-dir` is a usage error rather than a guess, because a harness server that
helpfully guessed a location is one that can be pointed at real data by omission.

Step 13 spawns the shipped binary, which DOES read `LIVING_ATLAS_STORE_DIR` — so
it is given a replacement environment holding only that variable, pointed at a
directory this suite created two lines earlier. Inheriting the parent's
environment would let a variable set on somebody's machine decide what the child
serves, and a test that passed because of a shell profile proves nothing.

Credential secrets are minted by the parent and never written to disk, never put
on the child's command line (argv is readable through `ps`), and never placed in
its environment (the child gets a replacement environment, not an inherited one).
The credential file the child reads holds **hashes and principals only**.

## Composing real components is not mocking them

`server-entry.ts` is harness wiring: it decides which directory the real answers
are written to and seeds a synthetic fixture on first boot. It is not the shipped
binary, and it is still the right vehicle for steps 1–12, which need a graph with
known contents and two credentials in it.

The shipped binary now opens a durable store of its own, from
`LIVING_ATLAS_STORE_DIR` (ADR 0028), and step 13 drives THAT — resolved through
`packages/atlas-mcp`'s own `bin` entry, so a test claiming "the shipped entry
serves a store" cannot keep passing against a file the package stopped shipping.
The two are kept apart on purpose: "the server works when a harness composes it"
and "the thing you install can be pointed at your graph" are different claims.
