import { CONTRACT_TOOL_NAMES } from "@living-atlas/atlas-contract";
import { LivingAtlasMcpToolNames } from "@living-atlas/mcp-contract";
import type { GatedPlane } from "./planes.js";
import { probeConsumerPlane } from "./probes.js";

/**
 * The two tool surfaces this repository currently contains, and what each is
 * held to.
 *
 * Tests are excluded from the source lints throughout, and deliberately: a test
 * that pins a limit by writing the number down is doing its job — that is what
 * makes it a test rather than a restatement of the implementation. A test that
 * enumerates a tool-name set is the same. The lints are about the code that
 * DECIDES, not about the code that checks the decision.
 */

const NOT_A_TEST = [/\.test\.ts$/];

export const CONSUMER_PLANE: GatedPlane = {
  id: "consumer-2026.08.0",
  title: "The published consumer contract and the servers that serve it",
  enforcement: "enforced",
  toolNames: CONTRACT_TOOL_NAMES,
  sources: {
    // The CLIENT is on this plane too, and it belongs here for the same reason
    // the server does: it is a second reader of the published contract, and the
    // failure mode a consumer client has is precisely the one these detectors
    // look for — a limit or a tool-name set written down again in the code that
    // calls, rather than read from the document that publishes it. A client that
    // drifted would refuse arguments the server accepts, with a reason visible
    // from neither side.
    roots: [
      "packages/atlas-contract/src",
      "packages/atlas-mcp/src",
      "packages/atlas-client/src",
      "packages/atlas-gates/src"
    ],
    authoring: [
      // The single authoring point for every published number and every
      // published tool name. Exempt because it is the source the rest of the
      // chain reads, not a copy of it.
      "packages/atlas-contract/src/revision.ts",
      // The single authoring point for every published SHAPE. It writes the caps
      // into the schemas; the generated baseline reads them back out.
      "packages/atlas-contract/src/catalog.ts",
      // The requirements register cites limits by value in its prose, which is
      // the document's purpose: a register that named no numbers would gate
      // nothing.
      "packages/atlas-contract/src/register.ts",
      // The operator plane's own two caps, in a file that exists to hold them.
      // They are not the consumer contract's numbers even where they coincide,
      // and the coincidence is exactly why they have a file of their own.
      "packages/atlas-mcp/src/operator/limits.ts"
    ],
    exclude: NOT_A_TEST
  },
  detectors: [
    "redeclared-tool-name-set",
    "transport-varying-limit",
    "input-schema-divergence",
    "advertised-tool-unimplemented",
    "literal-contract-constant"
  ],
  notApplicable: {},
  probe: probeConsumerPlane
};

export const LEGACY_PLANE: GatedPlane = {
  id: "legacy-30-tool",
  title: "The 30-tool consumer surface this contract replaces",
  enforcement: "quarantined",
  toolNames: LivingAtlasMcpToolNames,
  disposition:
    "Half demolished. The local half — the 30-tool registration in packages/local-mcp/src/server.ts " +
    "and the transports that served it — is deleted (ADR 0017), and the twenty-four ledger rows that " +
    "described its drift are deleted with it. What remains is the REMOTE half: packages/mcp-contract " +
    "still publishes the catalog and packages/graph-service still enforces it behind the worker. When " +
    "those two are deleted, delete this registration and its ledger in the same change.",
  sources: {
    // packages/local-mcp/src is deliberately not here any more. What survives in
    // that package is a graph-command library with no tool registration and no
    // transport, so scanning it for tool-surface drift would report findings
    // against a surface that no longer exists.
    roots: ["packages/mcp-contract/src", "packages/graph-service/src"],
    authoring: [
      // This plane's catalog. It is where the 30 tools and their caps are
      // declared, so it is the one file entitled to hold them.
      "packages/mcp-contract/src/index.ts"
    ],
    exclude: NOT_A_TEST
  },
  detectors: ["redeclared-tool-name-set", "transport-varying-limit"],
  notApplicable: {
    "literal-contract-constant":
      "This surface publishes no machine-readable manifest, so there is no generated baseline for a " +
      "literal to have come from. Running the rule here would report findings against a remedy that " +
      "does not exist on this plane, and a finding nobody can act on is how a gate loses its " +
      "audience. The rule runs on the consumer plane, which does have one.",
    "input-schema-divergence":
      "Both kinds were produced by probeLegacyPlane, which read the LOCAL server: it compared the " +
      "catalog's JSON Schema against the local zod shapes and read the localUnsupportedTool routing " +
      "out of the dispatch. That server is deleted, so the probe is deleted. The surviving remote " +
      "half authors its shapes ONCE — graph-service validates against the catalog it imports — so " +
      "there is no second authoring left on this plane to disagree with. Restoring these two " +
      "detectors here means driving packages/cloudflare-worker over the wire from a build gate, " +
      "which needs a worker runtime no gate may require.",
    "advertised-tool-unimplemented":
      "See input-schema-divergence: same probe, same deletion, same reason. The four tools that " +
      "routed to localUnsupportedTool were unreachable through the local dispatch that is now gone; " +
      "whether the worker answers them is a question for a wire probe against a worker runtime."
  },
  /**
   * THE LEDGER. What is left of it.
   *
   * It held twenty-seven rows across four kinds of drift. Twenty-four of them
   * described the LOCAL server — twenty-one input shapes authored twice, two
   * redeclared tool-name sets, and four advertised tools routed to
   * localUnsupportedTool — and all twenty-four are gone because the code they
   * described is gone. They were not fixed. They were demolished, which is a
   * different thing and worth saying plainly: nobody reconciled twenty-one zod
   * schemas against a catalog.
   *
   * The three that remain are the same defect the other twenty-four were: one
   * fact, written down twice, in two places that cannot see each other. All three
   * live in the REMOTE half, which this run did not touch.
   */
  quarantine: [
    // -----------------------------------------------------------------------
    // (1) THE LOCAL-ONLY DENY LIST, and its relatives.
    // A set of tool names that decides policy, declared outside the contract.
    // -----------------------------------------------------------------------
    {
      fingerprint:
        "redeclared-tool-name-set|packages/graph-service/src/index.ts|resolution_apply,review_decide,review_list,review_read",
      note:
        "The enforcing copy of the local-only deny list. packages/mcp-contract names SIX tools " +
        "local-only; this list — the one the graph service actually checks — names four. " +
        "migration_open and migration_seal, whose own catalog descriptions read \"Local-only\", are " +
        "therefore reachable over remote-http. Both copies type-check."
    },
    {
      fingerprint: "redeclared-tool-name-set|packages/graph-service/src/index.ts|edge_batch,object_batch",
      note:
        "Which tools are batchable, declared in the enforcing code rather than published. A client " +
        "can only find out by trying."
    },
    // -----------------------------------------------------------------------
    // (2) ONE BATCH CAP, TWO NUMBERS, CHOSEN BY TRANSPORT.
    // -----------------------------------------------------------------------
    {
      fingerprint: "transport-varying-limit|packages/graph-service/src/index.ts|LocalBatchMaxItems=100,RemoteBatchMaxItems=10",
      note:
        "The published schema tells every caller maxItems: 100. A remote caller sending 11 items is " +
        "refused by a limit that appears in no document it can read, and there is no tool it can " +
        "call to discover which number applies to it."
    }
  ]
};

export const GATED_PLANES: readonly GatedPlane[] = [CONSUMER_PLANE, LEGACY_PLANE];
