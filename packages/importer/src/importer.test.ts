import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixtureAuthorityId, sensitiveBaitRegistry } from "@living-atlas/fixtures";
import { scanForBaitStrings } from "@living-atlas/leakage";
	import {
	  createMarkdownImportPlan,
	  createMarkdownObjectId,
	  createMarkdownSourceRef,
	  createMarkdownWatcherPlan,
	  createLogseqSemanticGraphObjects,
	  createLogseqSemanticParityLedger,
	  planWatcherFileEvent,
	  summarizeMarkdownFile
} from "./index";

const syntheticSensitiveMarkdown = `---
title: Blue Orchid Salary Negotiation
tags:
  - private
created: 2026-02-14
---
# Blue Orchid Salary Negotiation

Avery North discussed Project Glass Lantern on 2026-02-14.

- related:: [[Project Glass Lantern]]
- id:: block-private-0001
- Follow up with [[Avery North]] and ((block-private-0001)).

## Edges

- Avery North estranged-from Example Person
`;

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

describe("markdown importer planning", () => {
  it("extracts markdown structure without serializing plaintext or source paths into the plan", () => {
    const file = {
      source_path: "/tmp/living-atlas-fixtures/Blue Orchid Salary Negotiation.md",
      markdown: syntheticSensitiveMarkdown,
      source_kind: "logseq" as const
    };

    const summary = summarizeMarkdownFile(file);
    expect(summary.detected_features).toEqual(expect.arrayContaining([
      "frontmatter",
      "headings",
      "wikilinks",
      "logseq-properties",
      "logseq-block-refs",
      "edges-section"
    ]));
    expect(summary.wikilink_count).toBe(2);
    expect(summary.logseq_property_count).toBe(2);
    expect(summary.plaintext_policy).toBe("hash-only-plan");

    const plan = createMarkdownImportPlan([file], {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z"
    });
    const planned = plan.files[0]!;

    expect(planned.planned_object.access_class).toBe("local-private");
    expect(planned.planned_object.encryption_class).toBe("client-encrypted");
    expect(planned.planned_object.visible_metadata.remote_indexable).toBe(false);
    expect(planned.planned_object.payload_plan.plaintext_in_plan).toBe(false);
    expect(JSON.stringify(plan)).not.toContain(file.source_path);

    expect(scanForBaitStrings([{ name: "import-plan", content: JSON.stringify(plan) }], sensitiveBaitRegistry)).toEqual([]);
  });

	  it("creates inert watcher plans and redacted per-event actions", () => {
    const watcher = createMarkdownWatcherPlan(
      [{ root_path: "/tmp/living-atlas-fixtures/Avery North vault", source_kind: "obsidian" }],
      { created_at: "2026-06-22T12:00:00.000Z", debounce_ms: 250 }
    );

    expect(watcher.execution_mode).toBe("planning-only");
    expect(watcher.roots[0]!.include_globs).toContain("**/*.md");
    expect(JSON.stringify(watcher)).not.toContain("Avery North");

    const changed = planWatcherFileEvent(
      {
        event_type: "modified",
        source_path: "/tmp/living-atlas-fixtures/Avery North vault/Project Glass Lantern.md",
        source_kind: "obsidian"
      },
      { authority_id: fixtureAuthorityId }
    );
    expect(changed.action).toBe("plan-import");
    expect(changed.requires_content_read).toBe(true);
    expect(JSON.stringify(changed)).not.toContain("Project Glass Lantern");

    const deleted = planWatcherFileEvent(
      {
        event_type: "deleted",
        source_path: "/tmp/living-atlas-fixtures/page.md",
        source_kind: "generic-markdown"
      },
      { authority_id: fixtureAuthorityId }
    );
    expect(deleted.action).toBe("plan-tombstone");
    expect(deleted.requires_content_read).toBe(false);
  });

  it("uses a caller secret to make markdown path refs stable without deterministic unsalted path hashes", () => {
    const sourcePath = "/tmp/living-atlas-fixtures/Avery North vault/Project Glass Lantern.md";
    const fixedSecret = "fixture-path-redaction-secret-0001";

	    expect(createMarkdownSourceRef(sourcePath, { path_redaction_secret: fixedSecret })).toBe(
	      createMarkdownSourceRef(sourcePath, { path_redaction_secret: fixedSecret })
	    );
	    expect(createMarkdownObjectId(fixtureAuthorityId, sourcePath, { path_redaction_secret: fixedSecret })).toBe(
	      createMarkdownObjectId(fixtureAuthorityId, sourcePath, { path_redaction_secret: fixedSecret })
	    );
	    expect(createMarkdownSourceRef(sourcePath, { path_redaction_secret: fixedSecret })).not.toBe(
	      createMarkdownSourceRef(sourcePath, { path_redaction_secret: "fixture-path-redaction-secret-0002" })
	    );
    expect(createMarkdownSourceRef(sourcePath)).not.toBe(createMarkdownSourceRef(sourcePath));

    const firstPlan = createMarkdownImportPlan([
	      {
	        source_path: sourcePath,
	        markdown: syntheticSensitiveMarkdown,
	        source_kind: "obsidian"
	      }
	    ], {
	      authority_id: fixtureAuthorityId,
	      created_at: "2026-06-22T12:00:00.000Z",
	      path_redaction_secret: fixedSecret
    });
    const secondPlan = createMarkdownImportPlan([
	      {
	        source_path: sourcePath,
	        markdown: syntheticSensitiveMarkdown,
	        source_kind: "obsidian"
	      }
	    ], {
	      authority_id: fixtureAuthorityId,
	      created_at: "2026-06-22T12:00:00.000Z",
	      path_redaction_secret: fixedSecret
    });

    expect(firstPlan.plan_id).toBe(secondPlan.plan_id);
	    expect(firstPlan.files[0]!.summary.source_path_ref).toBe(secondPlan.files[0]!.summary.source_path_ref);
	    expect(firstPlan.files[0]!.planned_object.object_id).toBe(secondPlan.files[0]!.planned_object.object_id);
	    expect(JSON.stringify(firstPlan)).not.toContain(sourcePath);
	  });

  it("builds a plaintext-free Logseq semantic parity ledger and encrypted semantic objects", async () => {
    const file = {
      source_path: "/tmp/living-atlas-fixtures/Blue Orchid Salary Negotiation.md",
      markdown: syntheticSensitiveMarkdown,
      source_kind: "logseq" as const
    };

    const ledger = createLogseqSemanticParityLedger([file], {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001"
    });

    expect(ledger.file_count).toBe(1);
    expect(ledger.totals.pages).toBe(1);
    expect(ledger.totals.blocks).toBeGreaterThan(0);
    expect(ledger.totals.wikilinks).toBe(2);
    expect(ledger.totals.block_refs).toBe(1);
    expect(ledger.totals.edge_candidates).toBe(1);
    expect(ledger.totals.valid_edge_candidates).toBe(1);
    expect(ledger.totals.planned_objects).toBeGreaterThan(ledger.totals.pages);
    expect(JSON.stringify(ledger)).not.toContain(file.source_path);
    expect(JSON.stringify(ledger)).not.toContain("Avery North");
    expect(JSON.stringify(ledger)).not.toContain("Project Glass Lantern");

    const encrypted = await createLogseqSemanticGraphObjects([file], {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001",
      encrypt: async ({ plaintext, aad }) => ({
        ciphertext: Buffer.from(`sealed:${aad}:${plaintext.length}`).toString("base64"),
        nonce: "fixture-semantic-nonce",
        hash: sha256(`sealed:${aad}:${plaintext.length}`),
        algorithm: "fixture-aes-gcm"
      })
    });

    expect(encrypted.ledger).toEqual(ledger);
    expect(encrypted.objects).toHaveLength(ledger.totals.planned_objects);
    expect(encrypted.objects.every((object) => object.encryption_class === "client-encrypted")).toBe(true);
    expect(encrypted.objects.every((object) => object.payload.kind === "ciphertext-inline")).toBe(true);
    expect(encrypted.objects.map((object) => object.object_type)).toEqual(expect.arrayContaining(["page", "block", "index", "edge"]));
    expect(JSON.stringify(encrypted.objects)).not.toContain("Avery North");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Project Glass Lantern");
  });

  it("quarantines direction-unsafe Logseq edge candidates instead of reversing them", () => {
    const ledger = createLogseqSemanticParityLedger([
      {
        source_path: "/tmp/living-atlas-fixtures/Unsafe Edge.md",
        markdown: "## Edges\n\n- [[Acquirer]] acquired [[Target]]\n",
        source_kind: "logseq"
      }
    ], {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001"
    });

    expect(ledger.totals.edge_candidates).toBe(1);
    expect(ledger.totals.valid_edge_candidates).toBe(0);
    expect(ledger.totals.quarantined_edge_candidates).toBe(1);
    expect(ledger.totals.quarantine_objects).toBe(1);
    expect(ledger.decisions["direction-unsafe-alias"]).toBe(1);
    expect(JSON.stringify(ledger)).not.toContain("Acquirer");
    expect(JSON.stringify(ledger)).not.toContain("Target");
  });
	});
