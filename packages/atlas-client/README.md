# @living-atlas/atlas-client

The typed consumer client for the published Living Atlas knowledge contract
(`2026.08.0`, MCP protocol revision `2026-07-28`).

The package root is the new plane and nothing else. The client for the thirty-tool
surface this contract replaces still exists — the live Cloudflare and
canonical-copy scripts in `packages/check` drive it — but it no longer answers to
the name "the Atlas client": it is at `@living-atlas/atlas-client/legacy`, and
importing it says so at the import site. See
`docs/architecture/adr-0022-typed-consumer-client-and-end-to-end-harness.md`.

## What it does that a hand-rolled caller does not

- **Reads the published bytes.** Schemas come from
  `packages/atlas-contract/schema/2026.08.0/` — the same documents the server
  registers from. Arguments are validated against the published *input* schema
  before anything is sent; results are validated against the published *output*
  schema before anything is returned.
- **Refuses rather than softens.** A result that fails its own published schema
  raises `AtlasContractViolation`. There is no lenient mode.
- **Speaks the envelope.** Every request carries the protocol revision, the
  declared client capabilities, client info and the credential, rebuilt per
  request because all of them are per-request input on this revision.
- **Negotiates once.** `server/discover` runs on first use and is cached for the
  TTL the server published. A `-32022` refusal is retried exactly once, and only
  after the negotiated revision actually changed.
- **Declares only what it can service.** `elicitation` is declared when, and only
  when, an elicitation decider was supplied.
- **Distinguishes the four ways a call can fail.** `AtlasToolRefusal` (Atlas
  answered, in contract, and said no), `AtlasCapabilityRequired` (`-32021`),
  `AtlasProtocolMismatch` (`-32022`), `AtlasContractViolation` (the answer was not
  in contract).

## Using it

```ts
import { AtlasConsumerClient, createStdioTransport } from "@living-atlas/atlas-client";

const client = new AtlasConsumerClient({
  transport: createStdioTransport({ command: "...", args: ["..."] }),
  credential: () => currentSecret(),
  // Supplying this declares the elicitation capability. Omitting it declares
  // none, and a reveal then comes back as the -32021 the spec requires.
  elicitation: async (request) => askTheOwner(request)
});

const contract = await client.describeContract();
const grant = await client.describeScope();
const page = await client.queryAssertions({ predicate: "worked-at" });
```

Read differences between deployments out of `describeScope()`. Never branch on
which transport you connected over — nothing in this client's public surface lets
you, and that is deliberate.

## Transports

`AtlasTransport` is one method: send a JSON-RPC request, get the response. Only
the stdio transport (an MCP server as a child process) ships here. An HTTP
transport implements the same interface, and everything above the seam — including
every end-to-end scenario in `@living-atlas/atlas-e2e` — is reused unchanged.
Nothing in `client.ts` reads a URL, a header, a pipe, or a process handle.

## Tests

- `contract-parity.test.ts` compares every TypeScript shape in this package
  against the published document, in both directions and for both "which members
  exist" and "which members are guaranteed". A member added to the contract and
  forgotten here fails the build, and so does the reverse.
- `client.test.ts` drives the protocol paths a conformant server cannot be made to
  produce on demand — a `-32022` naming an unsupported revision, a missing
  `resultType`, a result that violates its own schema. The double is the
  *transport*; no contract, schema or validation is stubbed.
- `credential-meta-key.test.ts` asserts the one string this package restates
  matches the server's.

For the full journey against a real server process, see `@living-atlas/atlas-e2e`.
