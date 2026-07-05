# Graph Workbench

The graph workbench is a local browser surface for inspecting and shaping graph
operations before wiring them to a real MCP or sync path. It defaults to a
synthetic graph and can opt into a read-only local graph projection.

## Scope

- Visualize nodes, edges, access class, encryption class, validation state, and
  a compact timeline.
- Create, update, tombstone, and import/export synthetic nodes.
- Create, end, and delete synthetic typed edges.
- Show the latest MCP-shaped operation draft for the selected CRUD action.
- Keep audit entries visible while editing.
- Keep graph state on the local workbench server, with browser fallback to
  in-memory state if the API is unavailable.
- Broadcast graph changes over a local event stream so another tab or future
  runtime surface can refresh when CRUD occurs.

By default, the workbench does not read private app-support data, does not
decrypt local graph files, and does not call Cloudflare. Real-data connection is
opt-in and starts as a read-only projection.

## Local Graph Projection

Enable read-only local graph projection:

```bash
LIVING_ATLAS_WORKBENCH_SOURCE=local-graph \
LIVING_ATLAS_WORKBENCH_LOCAL_GRAPH_ACK=read-local-graph-metadata-for-workbench \
LIVING_ATLAS_LOCAL_GRAPH_DIR=/path/to/local-graph \
npm run workbench:dev
```

This projects encrypted/ciphertext graph objects as redacted storage nodes and
does not expose sensitive plaintext.

Enable local keyring decryption for the workbench:

```bash
LIVING_ATLAS_WORKBENCH_SOURCE=local-graph \
LIVING_ATLAS_WORKBENCH_LOCAL_GRAPH_ACK=read-local-graph-metadata-for-workbench \
LIVING_ATLAS_WORKBENCH_DECRYPT_ACK=decrypt-local-graph-for-workbench \
LIVING_ATLAS_LOCAL_GRAPH_DIR=/path/to/local-graph \
LIVING_ATLAS_LOCAL_KEYRING=/path/to/local-keyring.json \
LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE='...' \
npm run workbench:dev
```

Only use decrypt mode on a trusted local machine. In local graph mode the
workbench API reports `mutable: false`, disables browser mutation controls, and
rejects mutation routes with `409 local-graph-workbench-is-readonly`.

## Local API

The browser uses these local-only routes:

- `GET /api/graph`
- `POST /api/graph/reset`
- `POST /api/graph/import`
- `POST /api/nodes`
- `PATCH /api/nodes/:object_id`
- `DELETE /api/nodes/:object_id`
- `POST /api/edges`
- `PATCH /api/edges/:edge_id`
- `DELETE /api/edges/:edge_id`
- `GET /api/events`
- `GET /api/events/stream`

These routes are the seam where adapters can call the local MCP, local graph
store, or remote MCP without rewriting the browser workbench. The synthetic
server source is mutable; the local graph source is read-only in this pass.

## Run

```bash
npm run workbench:dev
```

Open the printed localhost URL. The default port is `5177`; override it with
`LIVING_ATLAS_WORKBENCH_PORT`.

## Smoke Test

```bash
npm run workbench:smoke
```

The smoke test starts the local server on an ephemeral port and verifies the
HTML, CSS, browser module, shared graph-state module, graph API, and node-create
API are served.
