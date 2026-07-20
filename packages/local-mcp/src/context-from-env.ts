import { FileLocalControlStore, createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { decryptGraphObjectPayload, FileLocalKeyringStore, resolveLocalSecret } from "@living-atlas/local-keyring";
import { syntheticGraphObjects } from "@living-atlas/fixtures";
import { FileLocalMcpActivitySink } from "./activity";
import { FileLocalMcpAuditSink, InMemoryLocalMcpAuditSink } from "./audit";
import { createLocalMcpContextFromControlState } from "./local-graph";
import { FileLocalMcpMutationOutboxSink } from "./outbox";
import type { LocalControlState } from "@living-atlas/contracts";
import type { LocalMcpContext } from "./local-graph";

async function loadControlState(): Promise<{ controlState: LocalControlState; fixtureMode: boolean }> {
  const storePath = process.env.LIVING_ATLAS_LOCAL_CONTROL_STORE;
  const passphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE")?.value;
  const fixtureToken = process.env.LIVING_ATLAS_LOCAL_MCP_TOKEN;

  if (storePath && passphrase) {
    return {
      controlState: await new FileLocalControlStore(storePath).read(passphrase),
      fixtureMode: false
    };
  }

  if (fixtureToken) {
    return {
      controlState: await createFixtureLocalControlState(fixtureToken),
      fixtureMode: true
    };
  }

  throw new Error(
    "Set LIVING_ATLAS_LOCAL_CONTROL_STORE and LIVING_ATLAS_LOCAL_CONTROL_STORE_PASSPHRASE, or set LIVING_ATLAS_LOCAL_MCP_TOKEN for the synthetic fixture mode."
  );
}

async function loadGraphStore(
  controlState: LocalControlState,
  fixtureMode: boolean
): Promise<{
  graphStore?: FileLocalGraphStore;
  decryptPayload?: Parameters<typeof decryptGraphObjectPayload>[0] extends infer Object
    ? (object: Object) => ReturnType<typeof decryptGraphObjectPayload>
    : never;
}> {
  const directory = process.env.LIVING_ATLAS_LOCAL_GRAPH_DIR;
  if (!directory) {
    return {};
  }
  const keyringPath = process.env.LIVING_ATLAS_LOCAL_KEYRING;
  const keyringPassphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE")?.value;
  const keyring = keyringPath && keyringPassphrase
    ? await new FileLocalKeyringStore(keyringPath).read(keyringPassphrase)
    : undefined;

  const store = await FileLocalGraphStore.open({
    directory,
    authorityId: controlState.authority_id,
    plaintextPersistence: process.env.LIVING_ATLAS_LOCAL_GRAPH_PLAINTEXT === "allow" ? "allow" : keyring ? "encrypt" : "redact",
    keyring
  });

  if (fixtureMode && store.status().object_count === 0) {
    const initialized = await store.initializeFromObjects(syntheticGraphObjects);
    if (!initialized.ok) {
      throw new Error(`Failed to initialize local graph store: ${initialized.reason}`);
    }
  }

  return {
    graphStore: store,
    decryptPayload: keyring ? (object) => decryptGraphObjectPayload(object, keyring) : undefined
  };
}

export function localMcpAuthorizationHeaderFromEnv(): string | undefined {
  if (process.env.LIVING_ATLAS_LOCAL_MCP_AUTHORIZATION) {
    return process.env.LIVING_ATLAS_LOCAL_MCP_AUTHORIZATION;
  }

  if (process.env.LIVING_ATLAS_LOCAL_MCP_TOKEN) {
    return `Bearer ${process.env.LIVING_ATLAS_LOCAL_MCP_TOKEN}`;
  }

  return undefined;
}

/**
 * Build the one shared LocalMcpContext (control state, graph store, sinks) from
 * process env exactly as the standalone CLI does. Callers that own the process
 * for its whole lifetime (cli.ts, daemon.ts) call this once; the resulting
 * context's FileLocalGraphStore instance is safe to share across many
 * concurrent MCP protocol sessions because its internal mutation queue
 * serializes writes within this one process.
 */
export async function buildLocalMcpContextFromEnv(): Promise<{
  context: LocalMcpContext;
  authorizationHeader: string | undefined;
}> {
  const { controlState, fixtureMode } = await loadControlState();
  const localGraph = await loadGraphStore(controlState, fixtureMode);

  const context = createLocalMcpContextFromControlState({
    controlState,
    graphStore: localGraph.graphStore,
    decryptPayload: localGraph.decryptPayload,
    auditSink: process.env.LIVING_ATLAS_AUDIT_LOG
      ? new FileLocalMcpAuditSink(process.env.LIVING_ATLAS_AUDIT_LOG)
      : new InMemoryLocalMcpAuditSink(),
    activitySink: process.env.LIVING_ATLAS_ACTIVITY_LOG
      ? new FileLocalMcpActivitySink(process.env.LIVING_ATLAS_ACTIVITY_LOG)
      : undefined,
    outboxSink: process.env.LIVING_ATLAS_LOCAL_SYNC_OUTBOX_DIR
      ? new FileLocalMcpMutationOutboxSink(process.env.LIVING_ATLAS_LOCAL_SYNC_OUTBOX_DIR)
      : undefined
  });

  return { context, authorizationHeader: localMcpAuthorizationHeaderFromEnv() };
}

/**
 * Default Unix domain socket path for the local-mcp daemon: a sibling of the
 * graph directory so it lives alongside the replica it fronts. Falls back to
 * the OS tmpdir when no graph directory is configured (e.g. ad hoc/fixture
 * runs) so the daemon/proxy pair still has somewhere to rendezvous.
 */
export function localMcpSocketPathFromEnv(): string {
  if (process.env.LIVING_ATLAS_LOCAL_MCP_SOCKET) {
    return process.env.LIVING_ATLAS_LOCAL_MCP_SOCKET;
  }
  const replicaDir = process.env.LIVING_ATLAS_LOCAL_REPLICA_DIR;
  if (replicaDir) {
    return `${replicaDir}/local-mcp.sock`;
  }
  return `${process.env.TMPDIR ?? "/tmp"}/living-atlas-local-mcp.sock`;
}
