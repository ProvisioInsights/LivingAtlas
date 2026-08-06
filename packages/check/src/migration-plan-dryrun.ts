/**
 * Migration DRY RUN against the real replica.
 *
 * Read-only by construction: it opens the snapshot, decrypts in memory to build
 * the payload resolver, and writes NOTHING but the content-free plan report.
 * No target-plane sink is constructed, so `apply` cannot run from here even by
 * accident.
 *
 * Plaintext never reaches disk. The resolver holds decrypted payloads in a Map
 * for the life of the process because `LegacyPayloadResolver` is synchronous
 * while `decryptGraphObjectPayload` is async — pre-resolving is the only way to
 * satisfy the port without widening it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { decryptGraphObjectPayload, openLocalKeyring, resolveLocalSecret } from "@living-atlas/local-keyring";
import {
  buildProjectionPlan,
  evaluateClosureGate,
  renderProjectionPlanReport,
  type LegacyPayloadResolution
} from "@living-atlas/atlas-migrate";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const graphDir = requireEnv("LIVING_ATLAS_LOCAL_GRAPH_DIR");
  const keyringPath = requireEnv("LIVING_ATLAS_LOCAL_KEYRING");
  const authorityId = requireEnv("LIVING_ATLAS_BACKUP_AUTHORITY_ID");
  const reportOut = requireEnv("MIGRATION_PLAN_REPORT_OUT");

  const passphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE");
  if (!passphrase) throw new Error("keyring passphrase not resolvable");

  const keyring = await openLocalKeyring(JSON.parse(readFileSync(keyringPath, "utf8")), passphrase.value);

  const snapshot = JSON.parse(readFileSync(join(graphDir, "snapshot.json"), "utf8")) as {
    objects: GraphObjectEnvelope[];
  };
  const objects = snapshot.objects;
  process.stderr.write(`source objects: ${objects.length}\n`);

  // Pre-resolve payloads. A decrypt that FAILS is "unrecoverable" (we tried and
  // the bytes cannot be opened); a payload kind we never attempt is "unavailable".
  // Conflating them would report content as permanently lost when it is merely
  // unattempted — a false statement about absence.
  const resolved = new Map<string, Record<string, unknown>>();
  const failed = new Map<string, string>();
  let attempted = 0;

  for (const envelope of objects) {
    if (envelope.payload.kind === "plaintext-json") continue;
    if (envelope.payload.kind !== "ciphertext-inline") continue;
    attempted += 1;
    try {
      const payload = await decryptGraphObjectPayload(envelope, keyring);
      if (payload && payload.kind === "plaintext-json") {
        resolved.set(envelope.object_id, payload.data as Record<string, unknown>);
      } else {
        failed.set(envelope.object_id, "decrypt returned no plaintext payload");
      }
    } catch (error) {
      failed.set(envelope.object_id, (error as Error).message.slice(0, 120));
    }
    if (attempted % 5000 === 0) process.stderr.write(`  decrypted ${attempted}...\n`);
  }
  process.stderr.write(`decrypt: attempted=${attempted} ok=${resolved.size} failed=${failed.size}\n`);

  const resolvePayload = (envelope: GraphObjectEnvelope): LegacyPayloadResolution => {
    if (envelope.payload.kind === "plaintext-json") {
      return { kind: "plaintext", data: envelope.payload.data as Record<string, unknown> };
    }
    const data = resolved.get(envelope.object_id);
    if (data) return { kind: "plaintext", data };
    const detail = failed.get(envelope.object_id);
    if (detail) return { kind: "unrecoverable", detail };
    return { kind: "unavailable", detail: `payload kind ${envelope.payload.kind} not attempted` };
  };

  const plan = buildProjectionPlan(objects, { authority_id: authorityId, resolve_payload: resolvePayload });
  const gate = evaluateClosureGate(plan);
  const report = renderProjectionPlanReport(plan, gate);

  // Content-free by construction — see renderProjectionPlanReport.
  writeFileSync(reportOut, `${report}\n`, "utf8");
  process.stdout.write(`${report}\n`);
  // A failing gate is a real outcome, not a crash: exit non-zero so a caller
  // (or CI) cannot mistake "the projector refused to certify" for success.
  process.stderr.write(`\ngate ok: ${gate.ok}  findings: ${gate.findings.length}\n`);
  for (const finding of gate.findings) {
    // Severity first: a tolerated finding is still printed on every run, and the
    // operator has to be able to tell at a glance which ones held the gate open.
    process.stderr.write(`  [${finding.severity}] ${finding.code}: ${finding.subject_count}\n`);
  }
  if (!gate.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
