import { describe, expect, it } from "vitest";
import { fixtureAuthorityId, sensitiveBaitRegistry } from "@living-atlas/fixtures";
import { scanForBaitStrings } from "@living-atlas/leakage";
import {
  createMarkdownImportPlan,
  createMarkdownWatcherPlan,
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
});
