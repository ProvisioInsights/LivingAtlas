import { createHash, randomBytes, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createAtlasClient } from "@living-atlas/atlas-client";
import {
  GraphObjectEnvelopeSchema,
  type GraphObjectEnvelope,
  type LocalControlState
} from "@living-atlas/contracts";
import { createFixtureLocalControlState } from "@living-atlas/local-control-store";
import {
  buildCiphertextSyncBatch,
  fetchSyncEnvelopes,
  fetchSyncStatus,
  nextSyncGenerationFromStatus,
  submitSyncBatch
} from "@living-atlas/sync-agent";
import {
  createMarkdownImportPlan,
  MarkdownImportSourceKindSchema,
  type MarkdownImportSourceKind,
  type MarkdownFileInput
} from "../../importer/src";
import {
  printCloudflareLiveUsageGateResult,
  runCloudflareLiveUsageGate
} from "./cloudflare-live-usage-gate";
import {
  SemanticSourceModeSchema,
  walkImportableSemanticSourceFiles
} from "./logseq-semantic-source-files";

const liveAckEnv = "LIVING_ATLAS_REAL_DATA_PUSH_ACK";
const liveAckValue = "sync-real-ciphertext-to-cloudflare";
const legacyLiveAckValue = "sync-real-ciphertext-to-dev";
const defaultMaxFiles = 12;
const maxHardFiles = 25;
const maxFileBytes = 256_000;
const maxFileOffset = 1_000_000;
const textEncoder = new TextEncoder();

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function requireEnv(key: string): string {
  const value = envValue(key);
  if (!value) {
    throw new Error(`missing ${key}`);
  }
  return value;
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`expected positive integer <= ${max}, got ${value}`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, max: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`expected non-negative integer <= ${max}, got ${value}`);
  }
  return parsed;
}

function sourceKindForRoot(root: string): MarkdownImportSourceKind {
  const configured = envValue("LIVING_ATLAS_REAL_MARKDOWN_SOURCE_KIND");
  if (configured) {
    return MarkdownImportSourceKindSchema.parse(configured);
  }
  const lower = root.toLowerCase();
  if (lower.includes("logseq")) return "logseq";
  if (lower.includes("obsidian")) return "obsidian";
  return "generic-markdown";
}

function collectPlaintextNeedles(files: MarkdownFileInput[]): string[] {
  const needles = new Set<string>();
  for (const file of files) {
    const normalized = file.markdown.replace(/\s+/g, " ").trim();
    for (const match of normalized.matchAll(/[A-Za-z0-9][A-Za-z0-9 ,;:'"()[\]#/_-]{31,160}/g)) {
      const value = match[0]?.trim();
      if (value && value.length >= 32) {
        needles.add(value.slice(0, Math.min(value.length, 80)));
        break;
      }
    }
  }
  return [...needles].slice(0, files.length);
}

function assertNoNeedles(label: string, value: unknown, needles: string[]): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const needle of needles) {
    if (needle && serialized.includes(needle)) {
      throw new Error(`${label} leaked sampled plaintext`);
    }
  }
}

async function encryptPayload(plaintext: string, aad: string): Promise<{
  ciphertext: string;
  nonce: string;
  hash: `sha256:${string}`;
}> {
  const key = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const nonce = randomBytes(12);
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: textEncoder.encode(aad)
  }, key, textEncoder.encode(plaintext)));
  const encodedCiphertext = Buffer.from(ciphertext).toString("base64");
  const encodedNonce = Buffer.from(nonce).toString("base64");
  return {
    ciphertext: encodedCiphertext,
    nonce: encodedNonce,
    hash: sha256(`${encodedNonce}:${encodedCiphertext}`)
  };
}

async function encryptedObjectsFromMarkdown(input: {
  authorityId: string;
  files: MarkdownFileInput[];
  pathRedactionSecret: string;
  now: string;
}): Promise<GraphObjectEnvelope[]> {
  const plan = createMarkdownImportPlan(input.files, {
    authority_id: input.authorityId,
    created_at: input.now,
    path_redaction_secret: input.pathRedactionSecret
  });

  const objects: GraphObjectEnvelope[] = [];
  for (const [index, planned] of plan.files.entries()) {
    const file = input.files[index]!;
    const objectId = planned.planned_object.object_id;
    const aad = [
      "living-atlas-real-markdown-import:v1",
      input.authorityId,
      objectId,
      planned.summary.source_path_ref
    ].join(":");
    const encrypted = await encryptPayload(JSON.stringify({
      source_kind: file.source_kind,
      markdown: file.markdown
    }), aad);
    objects.push(GraphObjectEnvelopeSchema.parse({
      schema_version: 1,
      authority_id: input.authorityId,
      object_id: objectId,
      object_type: "page",
      version: 1,
      access_class: "local-private",
      encryption_class: "client-encrypted",
      created_at: input.now,
      updated_at: input.now,
      content_hash: encrypted.hash,
      key_ref: `la_key_realimport${digest(`${objectId}:key`, 18)}`,
      visible_metadata: {
        ...planned.planned_object.visible_metadata,
        schema_namespace: "import/real-markdown-readiness",
        remote_indexable: false
      },
      payload: {
        kind: "ciphertext-inline",
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        algorithm: "aes-256-gcm"
      }
    }));
  }
  return objects;
}

function remapControlState(input: LocalControlState, options: {
  authorityId: string;
  syncClientId: string;
  syncCapabilityId: string;
  syncDeviceId: string;
}): LocalControlState {
  const next = structuredClone(input);
  const originalPrimaryDeviceId = next.control_plane.devices[0]?.device_id;
  next.authority_id = options.authorityId;
  next.control_plane.authority = {
    ...next.control_plane.authority,
    authority_id: options.authorityId
  };
  next.control_plane.users = next.control_plane.users.map((user) => ({ ...user, authority_id: options.authorityId }));
  next.control_plane.devices = next.control_plane.devices.map((device, index) => ({
    ...device,
    authority_id: options.authorityId,
    device_id: index === 0 ? options.syncDeviceId : device.device_id
  }));
  next.control_plane.clients = next.control_plane.clients.map((client) => ({
    ...client,
    authority_id: options.authorityId,
    client_id: client.allowed_profile === "sync-device" ? options.syncClientId : client.client_id,
    device_id: client.device_id === originalPrimaryDeviceId ? options.syncDeviceId : client.device_id
  }));
  next.control_plane.capabilities = next.control_plane.capabilities.map((capability) => ({
    ...capability,
    authority_id: options.authorityId,
    capability_id: capability.profile === "sync-device" ? options.syncCapabilityId : capability.capability_id,
    client_id: capability.profile === "sync-device" ? options.syncClientId : capability.client_id
  }));
  next.control_plane.keys = next.control_plane.keys.map((key) => ({ ...key, authority_id: options.authorityId }));
  return next;
}

function latestGenerationFromSyncError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  if (!status || typeof status !== "object") {
    return undefined;
  }
  const latest = (status as { latest_generation?: unknown }).latest_generation;
  return typeof latest === "number" && Number.isInteger(latest) && latest >= 0 ? latest : undefined;
}

async function main(): Promise<void> {
  const root = envValue("LIVING_ATLAS_REAL_MARKDOWN_ROOT") ?? "./private-markdown-root";
  const maxFiles = parsePositiveInt(envValue("LIVING_ATLAS_REAL_DATA_FILE_COUNT"), defaultMaxFiles, maxHardFiles);
  const fileOffset = parseNonNegativeInt(envValue("LIVING_ATLAS_REAL_DATA_FILE_OFFSET"), 0, maxFileOffset);
  const sourceKind = sourceKindForRoot(root);
  const sourceMode = SemanticSourceModeSchema.parse(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_SOURCE_MODE") ?? "logseq-notes");
  const paths = await walkImportableSemanticSourceFiles({
    root,
    sourceKind,
    mode: sourceMode,
    maxFiles,
    offset: fileOffset,
    maxFileBytes
  });
  if (paths.length === 0) {
    throw new Error(`no semantic source files found under configured root at offset ${fileOffset}`);
  }

  const files: MarkdownFileInput[] = [];
  for (const path of paths) {
    files.push({
      source_path: relative(root, path),
      markdown: await readFile(path, "utf8"),
      source_kind: sourceKind
    });
  }

  const authorityId = envValue("LIVING_ATLAS_LIVE_AUTHORITY_ID") ?? "la_authority_realreadiness0001";
  const pathRedactionSecret = envValue("LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET") ?? randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  const plan = createMarkdownImportPlan(files, {
    authority_id: authorityId,
    created_at: now,
    path_redaction_secret: pathRedactionSecret
  });
  const needles = collectPlaintextNeedles(files);
  assertNoNeedles("real markdown import plan", plan, needles);

  const objects = await encryptedObjectsFromMarkdown({
    authorityId,
    files,
    pathRedactionSecret,
    now
  });
  assertNoNeedles("encrypted real graph envelopes", objects, needles);

  console.log("Living Atlas real-data local readiness passed");
  console.log(`files=${files.length}; offset=${fileOffset}; source_kind=${sourceKind}; source_mode=${sourceMode}; objects=${objects.length}; plaintext_needles=${needles.length}`);
  console.log(`bytes=${files.reduce((sum, file) => sum + Buffer.byteLength(file.markdown, "utf8"), 0)}; root_ref=sha256:${digest(root, 64)}`);

  const liveAck = envValue(liveAckEnv);
  if (liveAck !== liveAckValue && liveAck !== legacyLiveAckValue) {
    console.log(`live_push=skipped; set ${liveAckEnv}=${liveAckValue} to sync ciphertext to Cloudflare`);
    return;
  }

  const gate = await runCloudflareLiveUsageGate();
  printCloudflareLiveUsageGateResult(gate);
  if (!gate.ok) {
    throw new Error("usage gate refused real-data ciphertext push");
  }

  const endpoint = requireEnv("LIVING_ATLAS_LIVE_SYNC_ENDPOINT");
  const syncToken = requireEnv("LIVING_ATLAS_LIVE_SYNC_TOKEN");
  const syncClientId = requireEnv("LIVING_ATLAS_LIVE_SYNC_CLIENT_ID");
  const syncCapabilityId = requireEnv("LIVING_ATLAS_LIVE_SYNC_CAPABILITY_ID");
  const syncTokenId = envValue("LIVING_ATLAS_LIVE_SYNC_TOKEN_ID");
  const syncDeviceId = envValue("LIVING_ATLAS_LIVE_SYNC_DEVICE_ID") ?? `la_device_realready${digest(syncClientId, 18)}`;

  const status = await fetchSyncStatus({
    endpoint,
    syncToken,
    clientId: syncClientId,
    capabilityId: syncCapabilityId,
    tokenId: syncTokenId
  });
  if (!status.ok) {
    throw new Error(`sync status failed HTTP ${status.status_code}: ${JSON.stringify(status.error)}`);
  }
  const generation = nextSyncGenerationFromStatus(status.status);
  const controlState = remapControlState(await createFixtureLocalControlState(`real-data-readiness-${digest(now)}`), {
    authorityId,
    syncClientId,
    syncCapabilityId,
    syncDeviceId
  });
  let baseGeneration = generation.base_generation;
  let targetGeneration = generation.target_generation;
  let built = buildCiphertextSyncBatch({
    controlState,
    graphObjects: objects,
    syncClientId,
    tokenId: syncTokenId,
    baseGeneration,
    targetGeneration,
    now
  });
  assertNoNeedles("real-data sync batch", built.batch, needles);

  let submitted = await submitSyncBatch({
    endpoint,
    batch: built.batch,
    syncToken
  });
  if (!submitted.ok && submitted.status === 409) {
    const latest = latestGenerationFromSyncError(submitted.error);
    if (latest !== undefined && latest !== baseGeneration) {
      baseGeneration = latest;
      targetGeneration = latest + 1;
      built = buildCiphertextSyncBatch({
        controlState,
        graphObjects: objects,
        syncClientId,
        tokenId: syncTokenId,
        baseGeneration,
        targetGeneration,
        now: new Date().toISOString()
      });
      assertNoNeedles("real-data sync batch retry", built.batch, needles);
      submitted = await submitSyncBatch({
        endpoint,
        batch: built.batch,
        syncToken
      });
    }
  }
  if (!submitted.ok) {
    throw new Error(`real-data ciphertext sync failed HTTP ${submitted.status}: ${JSON.stringify(submitted.error)}`);
  }

  const pulled = await fetchSyncEnvelopes({
    endpoint,
    authorityId,
    afterGeneration: generation.base_generation,
    syncToken,
    clientId: syncClientId,
    capabilityId: syncCapabilityId,
    tokenId: syncTokenId
  });
  if (!pulled.ok) {
    throw new Error(`real-data envelope pull failed HTTP ${pulled.status_code}: ${JSON.stringify(pulled.error)}`);
  }
  assertNoNeedles("real-data pulled envelopes", pulled.response, needles);

  const client = createAtlasClient({
    endpoint,
    syncToken,
    clientId: syncClientId,
    capabilityId: syncCapabilityId,
    tokenId: syncTokenId
  });
  const decryptProbe = await client.callRemoteMcpTool("sensitive_decrypt", {
    authority_id: authorityId,
    object_id: objects[0]!.object_id
  });
  assertNoNeedles("real-data remote decrypt denial", decryptProbe, needles);
  if (decryptProbe.ok !== false) {
    throw new Error(`remote decrypt unexpectedly succeeded without cloud-unlock key: ${JSON.stringify(decryptProbe)}`);
  }

  console.log("Living Atlas real-data Cloudflare ciphertext sync passed");
  console.log(`authority=${authorityId}; generation=${submitted.accepted.target_generation}; synced_objects=${objects.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
