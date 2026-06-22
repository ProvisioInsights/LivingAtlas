# @living-atlas/atlas-client

Small headless TypeScript helpers for Praxis and other trusted consumers that
call Living Atlas remote MCP, activity, and usage surfaces.

The package keeps runtime behavior light:

- no Worker internals are imported
- tokens are sent as Living Atlas headers, never URL query parameters
- HTTP and JSON-RPC errors redact token-like fields before exposing details
- `fetch` is injectable for tests and non-browser runtimes

```ts
import { createAtlasClient } from "@living-atlas/atlas-client";

const atlas = createAtlasClient({
  endpoint: "https://living-atlas.example",
  syncToken: process.env.LIVING_ATLAS_SYNC_TOKEN,
  healthToken: process.env.LIVING_ATLAS_HEALTH_TOKEN
});

const tools = await atlas.listRemoteMcpTools();

const status = await atlas.callRemoteMcpTool("remote_sync_status", {});

const gate = await atlas.fetchUsageGate({
  windowHours: 6,
  maxBudgetRatio: 0.8,
  minWorkerRequestsRemaining: 1
});

const activity = await atlas.fetchActivityEvents({
  authorityId: "la_authority_example0001",
  cursor: "1700000000000:la_audit_example0001",
  limit: 25
});
```

`fetchActivityEvents` uses `/api/activity/audit` by default. It returns the
redacted, cursor-based audit stream that Praxis can render; object identifiers
and sync references are hashed, and tokens are only sent as headers.
