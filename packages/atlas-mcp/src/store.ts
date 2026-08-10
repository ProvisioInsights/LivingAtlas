import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AssertionLog,
  DurableAssertionLog,
  DurableEntityRegistry,
  EntityRegistry,
  scanIdentityLog,
  scanSegmentLog,
  type CommitResult,
  type Entity,
  type EntityId,
  type HistoryFloorAdvance,
  type RecordedAt
} from "@living-atlas/atlas-core";
import type { GraphSource } from "./graph.js";
import type { PredicateEntry } from "./vocabulary.js";

/**
 * Opening a DURABLE store from a directory, for both planes.
 *
 * Before this existed, `cli.ts` built an empty in-memory `AssertionLog` and
 * there was no supported way to point a client at a graph that already existed
 * (#71). The `GraphSource` seam was already there; nothing durable was behind
 * it. This module is what goes behind it.
 *
 * Three rules govern everything below, and each one is a defect that was
 * already paid for somewhere in this system:
 *
 *  1. **An absent store is an ERROR, never an empty one.** Nothing here calls
 *     `mkdir`. `atlas-core`'s own migration source refuses the same way and says
 *     why: "reporting a directory that does not exist as a store with zero
 *     objects is how a migration completes against nothing." The same sentence
 *     holds for a server — a typo'd path that answered every query with an empty
 *     page is a server that looks healthy while serving nothing.
 *  2. **One handle per store per process.** Two `SegmentWriter`s appending to
 *     one segment log interleave records and corrupt the commit groups the
 *     reader depends on. A second open of the same directory is refused here
 *     rather than left to whoever wires the entry point.
 *  3. **Read-only is the default, and it is real.** See `AtlasStoreMode`.
 */

/**
 * The directory holding the store. House style is `LIVING_ATLAS_*`, and this is
 * deliberately NOT `LIVING_ATLAS_LOCAL_GRAPH_DIR`: that names the frozen legacy
 * replica, which is never written after the freeze, and a server pointed at one
 * when it meant the other must fail rather than serve the wrong graph.
 */
export const STORE_DIRECTORY_ENV = "LIVING_ATLAS_STORE_DIR";

/** Opt-in to writing. Absent means `read-only` — see `AtlasStoreMode`. */
export const STORE_MODE_ENV = "LIVING_ATLAS_STORE_MODE";

/**
 * How the store was opened, which is a SECURITY POSTURE and not a performance
 * hint.
 *
 * `read-only` is the default because new-format backup does not exist yet. The
 * frozen legacy store plus its verified backup is the recovery story for what
 * was migrated; anything written into the new store afterwards is unprotected
 * until backup lands. A default that silently accepted writes would be choosing,
 * on the operator's behalf, to create data that cannot be recovered.
 *
 * `read-only` means it at the filesystem, not only at the tool boundary:
 *
 *  - the segment logs are scanned with `repair: false`, so a torn tail is
 *    REPORTED and the bytes are left exactly as they are. A read-only open that
 *    truncated a damaged file would be a write performed by something that
 *    promised not to write;
 *  - no `SegmentWriter` is constructed, so no header, no repair record and no
 *    new segment file is created;
 *  - the log is built with no journal, and `commit` is overridden to throw.
 *
 * The last one matters more than it looks. An `AssertionLog` with no journal
 * still accepts a commit — into RAM — and returns a receipt for it. That is
 * strictly worse than refusing: the caller is told its write landed and the
 * bytes are gone at exit. So the mutators exist and throw, which is the same
 * shape `LocalGraphMigrationSource` uses for the same reason: the honest
 * mistake is refused by the tool layer, the dishonest one fails loudly instead
 * of silently doing nothing.
 */
export type AtlasStoreMode = "read-only" | "read-write";

export const STORE_MODES: readonly AtlasStoreMode[] = ["read-only", "read-write"];

/**
 * Where each log lives under one store root.
 *
 * Separate directories because `atlas-core` refuses to load a directory holding
 * both: an assertion record found by the identity reader means two logs were
 * written into one place, and it says so rather than skipping what it does not
 * understand.
 *
 * The audit log is deliberately NOT part of this layout. Where a plane writes
 * its disclosure log is an argument to that plane, and folding it into the graph
 * store would mean a server pointed at a store inherits an audit destination it
 * was never told about.
 */
export type AtlasStoreLayout = {
  root: string;
  assertions: string;
  identity: string;
};

export function storeLayout(root: string): AtlasStoreLayout {
  return { root, assertions: join(root, "assertions"), identity: join(root, "identity") };
}

/**
 * What this process can say about the store it opened, with no graph content in
 * it.
 *
 * Counts and health, never records and never the directory path. A path is
 * deployment metadata; the operator supplied it and does not need it read back,
 * while anything that publishes it has made the store's location part of a tool
 * result.
 */
export type AtlasStoreStatus = {
  mode: AtlasStoreMode;
  feed_epoch: string;
  bitemporal_since: RecordedAt;
  published_watermark: number;
  assertions: number;
  entities: number;
  predicates: number;
  assertion_segments: number;
  identity_segments: number;
  /**
   * Damaged segment tails the load found. `mode` says what happened to them:
   * `read-write` truncated and recorded them, `read-only` left the bytes alone.
   */
  segment_repairs: number;
  /** Files in a log directory that are not segments. Reported, never skipped. */
  ignored_files: number;
  conflicting_supersessions: number;
  conflicting_alias_rows: number;
};

export type AtlasStore = {
  readonly mode: AtlasStoreMode;
  readonly layout: AtlasStoreLayout;
  readonly graph: GraphSource;
  /** Recomputed per call: `assertions` moves under a read-write store. */
  status(): AtlasStoreStatus;
  /** Releases the per-process handle. Safe to call twice. */
  close(): void;
};

export type OpenAtlasStoreOptions = {
  directory: string;
  /** Defaults to `read-only`. */
  mode?: AtlasStoreMode;
};

// ---------------------------------------------------------------------------
// the read-only log
// ---------------------------------------------------------------------------

const READ_ONLY_REFUSAL =
  "This store was opened read-only. The write was refused rather than accepted into memory: " +
  "an in-memory commit would return a receipt for bytes that vanish at exit.";

/**
 * An `AssertionLog` whose mutators exist and throw.
 *
 * `commit` is overridden rather than merely left journal-less because the base
 * class's `commit` succeeds without a journal. `advanceHistoryFloor` is
 * overridden for the same reason and a sharper one: the floor is a FORFEITURE,
 * and forfeiting history in RAM would make a read-only process start refusing
 * as-of reads that the store on disk can still answer.
 */
class ReadOnlyAssertionLog extends AssertionLog {
  override commit(): CommitResult {
    throw new Error(READ_ONLY_REFUSAL);
  }

  override advanceHistoryFloor(): HistoryFloorAdvance {
    throw new Error(READ_ONLY_REFUSAL);
  }
}

// ---------------------------------------------------------------------------
// the predicate vocabulary
// ---------------------------------------------------------------------------

/**
 * The live predicate registry, DERIVED from the assertions the store holds.
 *
 * OPEN QUESTION, recorded rather than quietly decided: the durable store carries
 * no predicate vocabulary of its own. `relational` is observable — an assertion
 * either carries a `target_entity_id` or it does not — but CARDINALITY is not.
 * Every derived predicate is therefore reported `multi-valued`, which is the
 * honest reading of "no functional key is declared for this predicate", and the
 * consequence is named in ADR 0028: a store-backed graph reports no
 * functional-key contradiction until the store can carry a vocabulary.
 *
 * Claiming `functional` from data would be the opposite error and a worse one —
 * Atlas would invent contradictions in a graph that never declared the
 * constraint.
 *
 * Superseded assertions are included. A consumer reading history with
 * `include_superseded` gets records whose predicate must still be in the
 * registry it validates against; a registry built from live records only would
 * omit exactly the predicates that history is made of.
 */
function derivePredicateRegistry(log: AssertionLog): PredicateEntry[] {
  const page = log.query({ include_superseded: true });
  // A query with no `as_of_recorded` cannot be refused by the history floor.
  // Handled anyway rather than asserted away: a refusal reported as an empty
  // vocabulary is the same class of silence this file exists to remove.
  if (!page.ok) return [];

  const relational = new Map<string, boolean>();
  for (const hit of page.hits) {
    const predicate = hit.assertion.predicate;
    const carriesTarget = hit.assertion.target_entity_id !== undefined;
    relational.set(predicate, (relational.get(predicate) ?? false) || carriesTarget);
  }

  return [...relational.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([predicate, isRelational]) => ({
      predicate,
      cardinality: "multi-valued" as const,
      relational: isRelational
    }));
}

/**
 * Recompute only when the log GREW.
 *
 * Not an optimisation for its own sake and not a cache with a staleness window:
 * `atlas.contract.describe.v1` publishes this registry, and a predicate first
 * asserted at runtime has to appear in it on the very next call, or the same
 * server publishes a vocabulary that contradicts a record it just returned.
 * `size` is O(1) and changes exactly when a commit lands, so the check is both
 * cheap and exact.
 */
function cachedPredicateRegistry(log: AssertionLog): () => readonly PredicateEntry[] {
  let sizeWhenDerived = -1;
  let derived: readonly PredicateEntry[] = [];
  return () => {
    if (log.size !== sizeWhenDerived) {
      derived = derivePredicateRegistry(log);
      sizeWhenDerived = log.size;
    }
    return derived;
  };
}

// ---------------------------------------------------------------------------
// the one-handle-per-store guard
// ---------------------------------------------------------------------------

/**
 * Stores this process already holds open, by resolved real path.
 *
 * Real paths rather than the strings a caller passed, because two spellings of
 * one directory — a relative path, a trailing slash, a symlink — are two handles
 * to the same segment log, and that is the corruption this guard exists to stop.
 */
const openDirectories = new Set<string>();

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

function requireDirectory(path: string, role: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `The Atlas store's ${role} directory does not exist: ${path}. ` +
        "It is refused rather than created: a directory that does not exist, served as a store " +
        "with zero records, is indistinguishable from a store that is genuinely empty."
    );
  }
  if (!statSync(path).isDirectory()) {
    throw new Error(`The Atlas store's ${role} path is not a directory: ${path}.`);
  }
}

export function openAtlasStore(options: OpenAtlasStoreOptions): AtlasStore {
  const mode: AtlasStoreMode = options.mode ?? "read-only";
  const layout = storeLayout(options.directory);

  // Checked BEFORE anything constructs a writer. `DurableAssertionLog.open`
  // mkdir's through `SegmentWriter`, so reaching it with a bad path would create
  // the very empty store this refusal exists to prevent.
  requireDirectory(layout.root, "root");
  requireDirectory(layout.assertions, "assertion log");
  requireDirectory(layout.identity, "identity log");

  const key = realpathSync(layout.root);
  if (openDirectories.has(key)) {
    throw new Error(
      `This process already holds the Atlas store at ${layout.root} open. ` +
        "A second handle is refused: two writers appending to one segment log interleave " +
        "records and corrupt the commit groups the reader depends on."
    );
  }
  openDirectories.add(key);

  try {
    return mode === "read-write" ? openReadWrite(layout, key) : openReadOnly(layout, key);
  } catch (cause) {
    // The handle is only held by a store that was actually built. Leaving it
    // registered after a failed open would make the retry — the thing an
    // operator does next — fail with the wrong reason.
    openDirectories.delete(key);
    throw cause;
  }
}

function openReadOnly(layout: AtlasStoreLayout, key: string): AtlasStore {
  const assertionScan = scanSegmentLog(layout.assertions, { repair: false });
  const identityScan = scanIdentityLog(layout.identity, { repair: false });

  const log = new ReadOnlyAssertionLog({
    feedEpoch: assertionScan.feed_epoch,
    bitemporalSince: assertionScan.history_floor,
    restored: assertionScan.restored
  });
  const registry = new EntityRegistry({ restored: identityScan.restored });
  const entities: readonly Entity[] = identityScan.restored.entities;

  return buildStore({
    mode: "read-only",
    layout,
    key,
    log,
    registry,
    entities: () => entities,
    counts: {
      assertion_segments: assertionScan.segments.length,
      identity_segments: identityScan.segments.length,
      segment_repairs: assertionScan.repairs.length + identityScan.repairs.length,
      ignored_files: assertionScan.ignored_files.length + identityScan.ignored_files.length,
      conflicting_supersessions: assertionScan.conflicting_supersessions.length,
      conflicting_alias_rows: identityScan.restored.conflicting_alias_rows.length
    },
    close: () => {
      // Nothing to close. No file handle was opened for writing, which is the
      // whole claim this mode makes.
    }
  });
}

function openReadWrite(layout: AtlasStoreLayout, key: string): AtlasStore {
  const durableAssertions = DurableAssertionLog.open({ directory: layout.assertions });

  let durableIdentity: DurableEntityRegistry;
  try {
    durableIdentity = DurableEntityRegistry.open({ directory: layout.identity });
  } catch (cause) {
    // Half an open is not an open. The identity log failing — a corrupt record,
    // an unreadable segment — must not leave the assertion log's writer holding
    // a file handle nobody has a reference to, because the retry an operator
    // makes next would then be the second writer this store refuses to have.
    durableAssertions.close();
    throw cause;
  }

  /**
   * The searchable set, seeded from the identity log and kept CURRENT.
   *
   * `EntityRegistry` exposes no enumeration — an id is read or resolved, never
   * listed — so the initial list comes from the log, after the durable registry
   * has opened and repaired it.
   *
   * It used to be a frozen array, correct only while this plane registered
   * nothing, with a comment saying a plane that ever gained an entity-write tool
   * would have to revisit it or find `atlas.text.search.v1` reporting fewer
   * plaintext candidates than the graph holds. 2026.08.3 is that plane, and that
   * is exactly what happened: measured against the live service, an entity
   * created through `atlas.entity.create.v1` was readable by id and invisible to
   * search — present in the store, absent from the one tool used to FIND things,
   * with `coverage.evaluated` under-reporting the graph.
   *
   * Keyed by id rather than appended, so a rename REPLACES the record instead of
   * leaving the old name in the searchable set beside the new one — which would
   * make an entity findable under a name it no longer has.
   */
  const searchable = new Map<EntityId, Entity>();
  for (const entity of scanIdentityLog(layout.identity, { repair: false }).restored.entities) {
    searchable.set(entity.entity_id, entity);
  }

  return buildStore({
    mode: "read-write",
    layout,
    key,
    // The log, not the wrapper: the wrapper's extra work is a warm read index
    // nothing on this path consults, while the log carries the journal — so
    // every commit is on disk before the receipt returns.
    log: durableAssertions.log,
    registry: durableIdentity.registry,
    entities: () => [...searchable.values()],
    rememberEntity: (entity) => searchable.set(entity.entity_id, entity),
    counts: {
      assertion_segments: durableAssertions.report.segments,
      identity_segments: durableIdentity.report.segments,
      segment_repairs: durableAssertions.report.repairs.length + durableIdentity.report.repairs.length,
      ignored_files: durableAssertions.report.ignored_files.length + durableIdentity.report.ignored_files.length,
      conflicting_supersessions: durableAssertions.report.conflicting_supersessions.length,
      conflicting_alias_rows: durableIdentity.report.conflicting_alias_rows.length
    },
    close: () => {
      durableAssertions.close();
      durableIdentity.close();
    }
  });
}

type BuildStoreInput = {
  mode: AtlasStoreMode;
  layout: AtlasStoreLayout;
  key: string;
  log: AssertionLog;
  registry: EntityRegistry;
  entities: () => readonly Entity[];
  /**
   * Called with every entity this store writes, so the searchable set stays
   * current. Absent on a read-only store, which writes none.
   */
  rememberEntity?: (entity: Entity) => void;
  counts: Pick<
    AtlasStoreStatus,
    | "assertion_segments"
    | "identity_segments"
    | "segment_repairs"
    | "ignored_files"
    | "conflicting_supersessions"
    | "conflicting_alias_rows"
  >;
  close: () => void;
};

function buildStore(input: BuildStoreInput): AtlasStore {
  const predicateRegistry = cachedPredicateRegistry(input.log);

  const graph: GraphSource = {
    assertions: input.log,
    entities: {
      read: (entityId: EntityId) => input.registry.read(entityId),
      resolve: (id: string) => input.registry.resolve(id),
      // Present ONLY read-write, and this is load-bearing rather than tidy: the
      // read-only registry is constructed with no journal, so a register/rename
      // through it would mutate RAM and return a record for bytes that vanish at
      // exit — the same lie `ReadOnlyAssertionLog.commit` refuses. Omitting the
      // methods makes the handler refuse with `store-read-only` before it can
      // reach for a writer that was never wired.
      ...(input.mode === "read-write"
        ? {
            register: (draft, context) => {
              const entity = input.registry.register(draft, context);
              // Remembered before the caller sees the record: a created entity
              // that is readable by id and invisible to `atlas.text.search.v1`
              // is present in the store and absent from the tool used to FIND
              // it. Measured against the live service before this line existed.
              input.rememberEntity?.(entity);
              return entity;
            },
            rename: (entityId: EntityId, change, context) => {
              const result = input.registry.rename(entityId, change, context);
              // Only on success, and it REPLACES: a failed rename must not touch
              // the searchable set, and a successful one must not leave the old
              // name in it beside the new.
              if (result.ok) input.rememberEntity?.(result.entity);
              return result;
            }
          }
        : {})
    },
    searchableEntities: () => input.entities(),
    // Zero, and true: `atlas-core` stores values in the clear, so nothing in
    // this store is excluded from a text scan for being encrypted. Stated rather
    // than omitted — omission is how an encrypted match and no match became
    // indistinguishable on the surface this contract replaces.
    encryptedUnsearchable: () => 0,
    predicateRegistry,
    readOnly: input.mode === "read-only"
  };

  let closed = false;
  return {
    mode: input.mode,
    layout: input.layout,
    graph,
    status: () => ({
      mode: input.mode,
      feed_epoch: input.log.feedEpoch,
      bitemporal_since: input.log.bitemporalSince,
      published_watermark: input.log.publishedWatermark,
      assertions: input.log.size,
      entities: input.entities().length,
      predicates: predicateRegistry().length,
      ...input.counts
    }),
    close: () => {
      if (closed) return;
      closed = true;
      input.close();
      openDirectories.delete(input.key);
    }
  };
}

// ---------------------------------------------------------------------------
// the environment
// ---------------------------------------------------------------------------

export type EnvironmentLike = Readonly<Record<string, string | undefined>>;

/**
 * The store directory this process was told to serve, or `undefined`.
 *
 * An EMPTY value is undefined rather than an error: `VAR=` in a shell profile is
 * how a variable is unset, and treating it as a request to open the directory
 * named by the empty string would refuse to start a server nobody asked to point
 * anywhere.
 */
export function storeDirectoryFromEnvironment(environment: EnvironmentLike): string | undefined {
  const value = environment[STORE_DIRECTORY_ENV];
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * The mode this process was told to open in. Unset is `read-only`.
 *
 * An unrecognised value THROWS rather than falling back. Falling back would mean
 * a typo in the one variable that decides whether a server may write silently
 * selects the safe answer today and the dangerous one the day the fallback is
 * ever flipped — and either way the operator is never told the value was not
 * understood.
 */
export function storeModeFromEnvironment(environment: EnvironmentLike): AtlasStoreMode {
  const value = environment[STORE_MODE_ENV];
  if (value === undefined || value.length === 0) return "read-only";
  const mode = STORE_MODES.find((candidate) => candidate === value);
  if (mode === undefined) {
    throw new Error(
      `${STORE_MODE_ENV} must be one of ${STORE_MODES.join(", ")}; it was ${JSON.stringify(value)}.`
    );
  }
  return mode;
}

/**
 * Open the store the environment names, or return `undefined` when it names
 * none.
 *
 * The one function both entry points call, so the two planes can never disagree
 * about which variable names the store, what the default mode is, or what
 * happens when the directory is not there.
 */
export function openStoreFromEnvironment(environment: EnvironmentLike): AtlasStore | undefined {
  const directory = storeDirectoryFromEnvironment(environment);
  if (directory === undefined) return undefined;
  return openAtlasStore({ directory, mode: storeModeFromEnvironment(environment) });
}
