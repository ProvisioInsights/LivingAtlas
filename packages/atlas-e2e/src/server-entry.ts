#!/usr/bin/env -S npx tsx
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_REVISION, loadContract, schemaDirectory } from "@living-atlas/atlas-contract";
import {
  DurableAssertionLog,
  DurableEntityRegistry,
  canonicalRecordedAt,
  scanIdentityLog,
  type Entity,
  type EntityId,
  type RecordedAt
} from "@living-atlas/atlas-core";
import {
  InMemoryCredentialDirectory,
  credentialResolver,
  serveAtlasStdio,
  type AuditEvent,
  type AuditJournal,
  type CredentialRecord,
  type GraphSource
} from "@living-atlas/atlas-mcp";
import {
  FIXTURE_ENTITY_NAMES,
  FIXTURE_FEED_EPOCH,
  FIXTURE_HISTORY_FLOOR,
  FIXTURE_OPEN_ASSERTIONS,
  SEALED_PREDICATE,
  WRITABLE_PREDICATE,
  fixturePredicateRegistry
} from "./fixture.js";
import { layoutFor } from "./layout.js";

/**
 * The server this harness spawns: the REAL consumer plane, bound to a durable
 * store in a temporary directory.
 *
 * What is real here is everything that decides anything. `serveAtlasStdio` is
 * the shipped entry, the twelve handlers are the shipped handlers, the schemas
 * are the published bytes, the protocol gate and the capability-refusal
 * transport are the shipped decorators, and the store is atlas-core's own
 * segment log. Nothing on the request path is stubbed, faked, or reimplemented
 * for the test.
 *
 * What is NOT the product is this file's own wiring — the data directory, the
 * synthetic fixture, and the credential file. `packages/atlas-mcp/src/cli.ts`
 * serves the SURFACE against an empty in-memory graph on purpose; wiring a
 * durable store to the shipped binary is a separate, reviewable act with real
 * data implications, and doing it here instead keeps that decision where it
 * belongs. Composing real components is not mocking them: the difference is that
 * a mock answers questions, and this file only decides which directory the real
 * answers are written to.
 *
 * It reads NOTHING outside the directory it is told to use. It has no
 * environment-variable fallbacks, no profile lookup, and no default path — a
 * missing `--data-dir` is a usage error, because a harness server that
 * helpfully guessed a location is a harness server that can be pointed at real
 * data by omission.
 */

function usage(message: string): never {
  process.stderr.write(`[atlas-e2e] ${message}\n`);
  process.stderr.write("usage: server-entry.ts --data-dir <path>\n");
  process.exit(2);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

/** Append-only, one JSON object per line. One line per tool call, never per record. */
function fileAuditJournal(path: string): AuditJournal {
  mkdirSync(dirname(path), { recursive: true });
  return {
    append: (event: AuditEvent) => {
      appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    }
  };
}

/**
 * The credential directory, loaded from a file that holds no secrets.
 *
 * Hashes and principals only. The parent process holds the secrets and presents
 * them per request; nothing on disk and nothing in this process's argv can be
 * read to obtain one. That is `InMemoryCredentialDirectory`'s own design note
 * used as intended, and it is why the harness does not pass secrets on the
 * command line — argv is world-readable through `ps`.
 */
function loadCredentials(path: string): InMemoryCredentialDirectory {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as CredentialRecord[];
  return new InMemoryCredentialDirectory(parsed);
}

const dataDirectory = argument("data-dir");
if (dataDirectory === undefined || dataDirectory.length === 0) usage("--data-dir is required");

const layout = layoutFor(dataDirectory);
mkdirSync(layout.assertions, { recursive: true });
mkdirSync(layout.identity, { recursive: true });

const durableAssertions = DurableAssertionLog.open({
  directory: layout.assertions,
  // Used only when the log is CREATED; a reopened log takes both from its own
  // segment header, which is what makes a restart invisible to a consumer.
  feedEpoch: FIXTURE_FEED_EPOCH,
  bitemporalSince: FIXTURE_HISTORY_FLOOR as RecordedAt
});
const durableIdentity = DurableEntityRegistry.open({ directory: layout.identity });

/**
 * The entities this graph can be searched over.
 *
 * Read back from the identity log rather than remembered from the seeding run,
 * because after a restart there IS no seeding run and the answer still has to be
 * the same list. `atlas.text.search.v1` must report `plaintext_candidates`
 * honestly, and a restarted server that reported zero candidates over a
 * populated graph would be reporting an absence that is not there — the exact
 * defect the coverage block exists to prevent.
 */
const entities: Entity[] = scanIdentityLog(layout.identity, { repair: false }).restored.entities;

seedIfEmpty();

function seedIfEmpty(): void {
  // Seeding is conditional on the log being EMPTY, not on a marker file. A
  // marker is a second source of truth about whether the graph has content, and
  // the two disagree the first time a seed half-fails.
  const existing = durableAssertions.log.query({});
  const alreadySeeded = existing.ok && existing.hits.length > 0;
  if (alreadySeeded || entities.length > 0) return;

  for (const displayName of FIXTURE_ENTITY_NAMES) {
    entities.push(
      durableIdentity.registry.register(
        { type: "person", display_name: displayName, also_known_as: [`alias-${displayName.split(" ").pop()?.toLowerCase() ?? "x"}`] },
        // `open` explicitly rather than by default: a fixture whose readability
        // changes when a privacy default changes is a fixture that stops testing
        // what it was written to test.
        { client_id: "fixture", sensitivity: { tier: "open", rank: 0, withheld: false } }
      )
    );
  }

  const subject = entities[0];
  const target = entities[1];
  if (!subject || !target) throw new Error("the fixture failed to register its entities");

  for (let index = 0; index < FIXTURE_OPEN_ASSERTIONS; index += 1) {
    durableAssertions.log.commit({
      client_id: "fixture",
      idempotency_key: `e2e-seed-open-${index}`,
      drafts: [
        {
          kind: "fact",
          lineage_action: "assert",
          subject_entity_id: subject.entity_id,
          predicate: WRITABLE_PREDICATE,
          value: `Synthetic Employer ${index}`,
          confidence: { band: "high" },
          evidence_links: [{ evidence_id: `ev-seed-${index}`, stance: "supports" }],
          supersedes: []
        }
      ],
      sensitivity: { tier: "open", rank: 0, withheld: false }
    });
  }

  durableAssertions.log.commit({
    client_id: "fixture",
    idempotency_key: "e2e-seed-relationship",
    drafts: [
      {
        kind: "relationship",
        lineage_action: "assert",
        subject_entity_id: subject.entity_id,
        predicate: "reports-to",
        target_entity_id: target.entity_id,
        confidence: { band: "high" },
        evidence_links: [{ evidence_id: "ev-seed-edge", stance: "supports" }],
        supersedes: []
      }
    ],
    sensitivity: { tier: "open", rank: 0, withheld: false }
  });

  // One record no credential in this harness may read, so the redaction stub and
  // the reveal escalation have something real to be about.
  durableAssertions.log.commit({
    client_id: "fixture",
    idempotency_key: "e2e-seed-sealed",
    drafts: [
      {
        kind: "fact",
        lineage_action: "assert",
        subject_entity_id: subject.entity_id,
        predicate: SEALED_PREDICATE,
        value: "synthetic sealed value",
        confidence: { band: "high" },
        evidence_links: [{ evidence_id: "ev-seed-sealed", stance: "supports" }],
        supersedes: []
      }
    ],
    sensitivity: { tier: "sealed", rank: 90, withheld: true }
  });
}

const graph: GraphSource = {
  // `durableAssertions.log`, not the wrapper: the wrapper's extra work is a warm
  // read index nothing on this path consults, while the log itself carries the
  // journal, so every commit through it is on disk before the receipt returns.
  assertions: durableAssertions.log,
  entities: {
    read: (entityId: EntityId) => durableIdentity.registry.read(entityId),
    resolve: (id: string) => durableIdentity.registry.resolve(id)
  },
  searchableEntities: () => entities,
  // Zero, and true: this harness holds no encrypted content. Reported rather
  // than omitted, because omission is how an encrypted match and no match became
  // indistinguishable on the surface this contract replaces.
  encryptedUnsearchable: () => 0,
  predicateRegistry: () => fixturePredicateRegistry()
};

const contractPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "atlas-contract");

const handle = serveAtlasStdio({
  contract: loadContract(schemaDirectory(contractPackageRoot, CONTRACT_REVISION)),
  graph,
  auditJournal: fileAuditJournal(layout.auditLog),
  resolvePrincipal: credentialResolver({ directory: loadCredentials(layout.credentials), plane: "consumer" }),
  // stderr, never stdout: stdout is the JSON-RPC wire, and one stray line on it
  // corrupts framing for every message after it.
  onerror: (error) => process.stderr.write(`[atlas-e2e] ${error.message}\n`),
  onProtocolRejection: (rejection) =>
    process.stderr.write(`[atlas-e2e] refused ${rejection.method}: protocol revision ${rejection.requested ?? "(unnamed)"}\n`)
});

// The single line the harness waits for. Printed AFTER the store is open and the
// fixture is settled, so a test that starts sending on seeing it cannot race the
// seed — a race that would show up as a flaky empty graph rather than as a
// failure anyone could read.
process.stderr.write(`[atlas-e2e] ready feed_epoch=${durableAssertions.log.feedEpoch} floor=${canonicalRecordedAt(new Date(FIXTURE_HISTORY_FLOOR))}\n`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    durableAssertions.close();
    durableIdentity.close();
    void handle.close();
    process.exit(0);
  });
}
