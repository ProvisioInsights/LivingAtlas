import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixtureAuthorityId, sensitiveBaitRegistry } from "@living-atlas/fixtures";
import { scanForBaitStrings } from "@living-atlas/leakage";
import {
  classifyMarkdownSourcePath,
  createMarkdownImportPlan,
  createMarkdownObjectId,
  createMarkdownSourceRef,
  createMarkdownWatcherPlan,
  createLogseqSemanticGraphObjects,
  createLogseqSemanticParityLedger,
  createLogseqSemanticPlaintextGraphObjects,
  createLogseqSemanticReviewTargetHash,
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

  it("classifies Logseq extensionless page and journal files without accepting attachments", () => {
    expect(classifyMarkdownSourcePath({
      source_path: "pages/Project Glass Lantern",
      source_kind: "logseq"
    })).toEqual({ supported: true, reason_code: "logseq-extensionless-note" });
    expect(classifyMarkdownSourcePath({
      source_path: "journals/2026_06_23",
      source_kind: "logseq"
    })).toEqual({ supported: true, reason_code: "logseq-extensionless-note" });
    expect(classifyMarkdownSourcePath({
      source_path: "pages/Project Glass Lantern.md",
      source_kind: "logseq"
    })).toEqual({ supported: true, reason_code: "markdown-file" });
    expect(classifyMarkdownSourcePath({
      source_path: "pages/Project Glass Lantern",
      source_kind: "obsidian"
    })).toEqual({ supported: false, reason_code: "unsupported-extensionless" });
    expect(classifyMarkdownSourcePath({
      source_path: "assets/blob",
      source_kind: "logseq"
    })).toEqual({ supported: false, reason_code: "unsupported-extensionless" });
    expect(classifyMarkdownSourcePath({
      source_path: "assets/pages/blob",
      source_kind: "logseq"
    })).toEqual({ supported: false, reason_code: "unsupported-extensionless" });
    expect(classifyMarkdownSourcePath({
      source_path: "logseq/bak/pages/Old Page",
      source_kind: "logseq"
    })).toEqual({ supported: false, reason_code: "ignored-extension" });
    expect(classifyMarkdownSourcePath({
      source_path: "pages/.fuse_hidden000001c800000162",
      source_kind: "logseq"
    })).toEqual({ supported: false, reason_code: "ignored-extension" });
    expect(classifyMarkdownSourcePath({
      source_path: ".trash/pages/Project Glass Lantern",
      source_kind: "logseq"
    })).toEqual({ supported: false, reason_code: "ignored-extension" });
    expect(classifyMarkdownSourcePath({
      source_path: "pages/image.png",
      source_kind: "logseq"
    })).toEqual({ supported: false, reason_code: "ignored-extension" });
  });

  it("creates inert watcher plans and redacted per-event actions", () => {
    const watcher = createMarkdownWatcherPlan(
      [{ root_path: "/tmp/living-atlas-fixtures/Avery North vault", source_kind: "logseq" }],
      { created_at: "2026-06-22T12:00:00.000Z", debounce_ms: 250 }
    );

    expect(watcher.execution_mode).toBe("planning-only");
    expect(watcher.roots[0]!.include_globs).toEqual(expect.arrayContaining(["pages/**", "journals/**", "whiteboards/**/*.md"]));
    expect(JSON.stringify(watcher)).not.toContain("Avery North");

    const changed = planWatcherFileEvent(
      {
        event_type: "modified",
        source_path: "pages/Project Glass Lantern",
        source_kind: "logseq"
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

    const ignoredAttachment = planWatcherFileEvent(
      {
        event_type: "modified",
        source_path: "assets/blob",
        source_kind: "logseq"
      },
      { authority_id: fixtureAuthorityId }
    );
    expect(ignoredAttachment.action).toBe("ignore");
    expect(ignoredAttachment.requires_content_read).toBe(false);

    const ignoredBackup = planWatcherFileEvent(
      {
        event_type: "modified",
        source_path: "logseq/bak/pages/Old Page",
        source_kind: "logseq"
      },
      { authority_id: fixtureAuthorityId }
    );
    expect(ignoredBackup.action).toBe("ignore");
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
    expect(ledger.totals.valid_edge_candidates).toBe(0);
    expect(ledger.totals.quarantined_edge_candidates).toBe(1);
    expect(ledger.totals.source_capsule_objects).toBe(1);
    expect(ledger.files[0]!.source_hash_before).toBe(ledger.files[0]!.content_hash);
    expect(ledger.files[0]!.source_hash_after).toBe(ledger.files[0]!.content_hash);
    expect(ledger.files[0]!.review_status).toBe("needs-review");
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
    expect(encrypted.objects.map((object) => object.object_type)).toEqual(expect.arrayContaining(["attachment", "page", "block", "index", "edge"]));
    expect(encrypted.objects).toContainEqual(expect.objectContaining({
      object_type: "attachment",
      visible_metadata: expect.objectContaining({
        schema_namespace: "import/logseq-semantic/source-capsule",
        remote_indexable: false
      })
    }));
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

  it("promotes explicit typed Logseq edge lines into encrypted temporal edge objects", async () => {
    const file = {
      source_path: "/tmp/living-atlas-fixtures/Typed Edge.md",
      markdown: "## Edges\n\n- [[Avery North]] (person) advises [[Project Glass Lantern]] (project) from 2026-06\n",
      source_kind: "logseq" as const
    };

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

    expect(encrypted.ledger.totals.edge_candidates).toBe(1);
    expect(encrypted.ledger.totals.valid_edge_candidates).toBe(1);
    expect(encrypted.ledger.totals.quarantine_objects).toBe(0);
    expect(encrypted.ledger.decisions["typed-edge-promoted"]).toBe(1);
    expect(encrypted.ledger.files[0]!.objects).toContainEqual(expect.objectContaining({
      semantic_kind: "typed-edge",
      object_type: "edge",
      decision: "captured-encrypted",
      plaintext_in_plan: false
    }));
    expect(encrypted.objects).toContainEqual(expect.objectContaining({
      object_type: "edge",
      visible_metadata: expect.objectContaining({
        schema_namespace: "import/logseq-semantic/typed-edge",
        remote_indexable: false
      }),
      payload: expect.objectContaining({
        kind: "ciphertext-inline"
      })
    }));
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Avery North");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Project Glass Lantern");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Avery North");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Project Glass Lantern");
  });

  it("builds local-only plaintext semantic drafts for keyring-backed local persistence", () => {
    const file = {
      source_path: "/tmp/living-atlas-fixtures/Typed Edge.md",
      markdown: "## Edges\n\n- [[Avery North]] (person) advises [[Project Glass Lantern]] (project) from 2026-06\n",
      source_kind: "logseq" as const
    };

    const built = createLogseqSemanticPlaintextGraphObjects([file], {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001"
    });

    const edgeObject = built.objects.find((object) => object.object_type === "edge");
    expect(edgeObject).toEqual(expect.objectContaining({
      object_type: "edge",
      access_class: "local-private",
      encryption_class: "plaintext",
      visible_metadata: expect.objectContaining({
        schema_namespace: "import/logseq-semantic/typed-edge",
        remote_indexable: false,
        tombstone: false
      }),
      payload: expect.objectContaining({
        kind: "plaintext-json",
        data: expect.objectContaining({
          kind: "logseq-temporal-edge"
        })
      })
    }));
    expect((edgeObject?.payload.data.edge as { predicate?: string } | undefined)?.predicate).toBe("advises");
    expect(JSON.stringify(built.ledger)).not.toContain("Avery North");
    expect(JSON.stringify(built.ledger)).not.toContain("Project Glass Lantern");
  });

  it("promotes explicit typed Logseq pages into encrypted endpoint objects", async () => {
    const file = {
      source_path: "/tmp/living-atlas-fixtures/Synthetic Topic.md",
      markdown: "type:: topic\nsubtype:: theme\naliases:: Synthetic Theme, [[Synthetic Alias]]\nparent-topic:: [[Synthetic Parent Topic]]\ntags:: #alpha, beta\n\n- body text\n",
      source_kind: "logseq" as const
    };
    const plaintextPayloads: string[] = [];

    const encrypted = await createLogseqSemanticGraphObjects([file], {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001",
      encrypt: async ({ plaintext, aad }) => {
        plaintextPayloads.push(plaintext);
        return {
          ciphertext: Buffer.from(`sealed:${aad}:${plaintext.length}`).toString("base64"),
          nonce: "fixture-semantic-nonce",
          hash: sha256(`sealed:${aad}:${plaintext.length}`),
          algorithm: "fixture-aes-gcm"
        };
      }
    });
    const endpointPayload = plaintextPayloads
      .map((payload) => JSON.parse(payload) as { kind?: string; endpoint?: { type?: string; subtype?: string; aliases?: string[]; parent_topic_ref?: string; tags?: string[] } })
      .find((payload) => payload.kind === "logseq-endpoint")!;

    expect(encrypted.ledger.decisions["typed-endpoint-promoted"]).toBe(1);
    expect(endpointPayload.endpoint).toMatchObject({
      type: "topic",
      subtype: "theme",
      aliases: ["Synthetic Theme", "Synthetic Alias"],
      tags: ["alpha", "beta"]
    });
    expect(endpointPayload.endpoint?.parent_topic_ref).toMatch(/^la_object_[a-f0-9]{24}$/);
    expect(encrypted.ledger.files[0]!.objects).toContainEqual(expect.objectContaining({
      semantic_kind: "typed-endpoint",
      object_type: "page",
      decision: "captured-encrypted",
      plaintext_in_plan: false
    }));
    expect(encrypted.objects).toContainEqual(expect.objectContaining({
      object_type: "page",
      visible_metadata: expect.objectContaining({
        schema_namespace: "import/logseq-semantic/typed-endpoint",
        remote_indexable: false
      }),
      payload: expect.objectContaining({
        kind: "ciphertext-inline"
      })
    }));
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Topic");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Alias");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Topic");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Alias");
  });

  it("promotes offering and item Logseq pages into encrypted endpoint objects", async () => {
    const files = [
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Product.md",
        markdown: "type:: offering\nsubtype:: software-product\nprovider:: [[Synthetic Vendor]]\nwebsite:: https://example.invalid/product\nstatus:: active\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Device.md",
        markdown: "type:: device\nproduct:: [[Synthetic Product]]\nowner:: [[Synthetic Owner]]\nlocation:: [[Synthetic Room]]\nacquired-on:: 2026-06\nstatus:: owned\n\n- body text\n",
        source_kind: "logseq" as const
      }
    ];
    const plaintextPayloads: string[] = [];

    const encrypted = await createLogseqSemanticGraphObjects(files, {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001",
      encrypt: async ({ plaintext, aad }) => {
        plaintextPayloads.push(plaintext);
        return {
          ciphertext: Buffer.from(`sealed:${aad}:${plaintext.length}`).toString("base64"),
          nonce: "fixture-semantic-nonce",
          hash: sha256(`sealed:${aad}:${plaintext.length}`),
          algorithm: "fixture-aes-gcm"
        };
      }
    });
    const endpointPayloads = plaintextPayloads
      .map((payload) => JSON.parse(payload) as {
        kind?: string;
        endpoint?: {
          type?: string;
          subtype?: string;
          provider_ref?: string;
          offering_ref?: string;
          owner_ref?: string;
          location_ref?: string;
          acquired_on?: string;
          status?: string;
        };
      })
      .filter((payload) => payload.kind === "logseq-endpoint");

    expect(encrypted.ledger.decisions["typed-endpoint-promoted"]).toBe(2);
    expect(endpointPayloads.map((payload) => payload.endpoint)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "offering",
        subtype: "software-product",
        status: "active",
        provider_ref: expect.stringMatching(/^la_object_[a-f0-9]{24}$/)
      }),
      expect.objectContaining({
        type: "item",
        subtype: "device",
        status: "owned",
        acquired_on: "2026-06",
        offering_ref: expect.stringMatching(/^la_object_[a-f0-9]{24}$/),
        owner_ref: expect.stringMatching(/^la_object_[a-f0-9]{24}$/),
        location_ref: expect.stringMatching(/^la_object_[a-f0-9]{24}$/)
      })
    ]));
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Product");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Device");
  });

  it("maps occurrence endpoint timing, references, and RFC 5545 recurrence into encrypted payloads", async () => {
    const file = {
      source_path: "/tmp/living-atlas-fixtures/Synthetic Weekly Meeting.md",
      markdown: [
        "type:: occurrence",
        "subtype:: meeting",
        "occurred-on:: 2026-06-24",
        "scheduled-start:: 2026-06-24T14:00:00.000Z",
        "scheduled-end:: 2026-06-24T15:00:00.000Z",
        "timezone:: America/Chicago",
        "location:: [[Synthetic HQ]]",
        "participants:: [[Person A]], [[Synthetic Org]]",
        "organizer:: [[Person B]]",
        "project:: [[Synthetic Project]]",
        "recurrence-set:: DTSTART;TZID=America/Chicago:20260624T090000\\nRRULE:FREQ=WEEKLY;BYDAY=WE",
        "duration:: PT1H",
        "",
        "- body text"
      ].join("\n"),
      source_kind: "logseq" as const
    };
    const plaintextPayloads: string[] = [];

    const encrypted = await createLogseqSemanticGraphObjects([file], {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001",
      encrypt: async ({ plaintext, aad }) => {
        plaintextPayloads.push(plaintext);
        return {
          ciphertext: Buffer.from(`sealed:${aad}:${plaintext.length}`).toString("base64"),
          nonce: "fixture-semantic-nonce",
          hash: sha256(`sealed:${aad}:${plaintext.length}`),
          algorithm: "fixture-aes-gcm"
        };
      }
    });
    const endpointPayload = plaintextPayloads
      .map((payload) => JSON.parse(payload) as { kind?: string; endpoint?: Record<string, unknown> })
      .find((payload) => payload.kind === "logseq-endpoint")!;

    expect(encrypted.ledger.decisions["typed-endpoint-promoted"]).toBe(1);
    expect(endpointPayload.endpoint).toMatchObject({
      type: "occurrence",
      subtype: "meeting",
      occurred_on: "2026-06-24",
      scheduled_start: "2026-06-24T14:00:00.000Z",
      scheduled_end: "2026-06-24T15:00:00.000Z",
      timezone: "America/Chicago",
      recurrence: {
        timezone: "America/Chicago",
        recurrence_set: "DTSTART;TZID=America/Chicago:20260624T090000\nRRULE:FREQ=WEEKLY;BYDAY=WE",
        duration: "PT1H",
        exceptions: []
      }
    });
    expect(endpointPayload.endpoint?.location_ref).toMatch(/^la_object_[a-f0-9]{24}$/);
    expect(endpointPayload.endpoint?.participant_refs).toHaveLength(2);
    expect(endpointPayload.endpoint?.organizer_refs).toHaveLength(1);
    expect(endpointPayload.endpoint?.project_refs).toHaveLength(1);
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Weekly Meeting");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Weekly Meeting");
  });

  it("does not promote pages without an accepted endpoint type", () => {
    const ledger = createLogseqSemanticParityLedger([
      {
        source_path: "/tmp/living-atlas-fixtures/Untyped Page.md",
        markdown: "type:: loose-note\n\n- body text\n",
        source_kind: "logseq"
      }
    ], {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001"
    });

    expect(ledger.decisions["typed-endpoint-promoted"]).toBeUndefined();
    expect(ledger.files[0]!.objects).not.toContainEqual(expect.objectContaining({
      semantic_kind: "typed-endpoint"
    }));
    expect(ledger.totals.quarantine_objects).toBe(0);
    expect(JSON.stringify(ledger)).not.toContain("Untyped Page");
  });

  it("keeps typed endpoint promotion when optional mapped fields are invalid", () => {
    const ledger = createLogseqSemanticParityLedger([
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Bad Optional Field.md",
        markdown: "type:: organization\nfounded-year:: not-a-date\n\n- body text\n",
        source_kind: "logseq"
      }
    ], {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001"
    });

    expect(ledger.decisions["typed-endpoint-promoted"]).toBe(1);
    expect(ledger.totals.quarantine_objects).toBe(0);
    expect(ledger.files[0]!.objects).toContainEqual(expect.objectContaining({
      semantic_kind: "typed-endpoint",
      decision: "captured-encrypted",
      plaintext_in_plan: false
    }));
    expect(JSON.stringify(ledger)).not.toContain("Synthetic Bad Optional Field");
    expect(JSON.stringify(ledger)).not.toContain("not-a-date");
  });

  it("promotes safe endpoint type aliases without accepting unrelated page categories", async () => {
    const files = [
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Org Alias.md",
        markdown: "type:: org\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Meeting Alias.md",
        markdown: "type:: meeting\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Cluster.md",
        markdown: "type:: cluster\n\n- body text\n",
        source_kind: "logseq" as const
      }
    ];
    const plaintextPayloads: string[] = [];

    const encrypted = await createLogseqSemanticGraphObjects(files, {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001",
      encrypt: async ({ plaintext, aad }) => {
        plaintextPayloads.push(plaintext);
        return {
          ciphertext: Buffer.from(`sealed:${aad}:${plaintext.length}`).toString("base64"),
          nonce: "fixture-semantic-nonce",
          hash: sha256(`sealed:${aad}:${plaintext.length}`),
          algorithm: "fixture-aes-gcm"
        };
      }
    });
    const endpointPayloads = plaintextPayloads
      .map((payload) => JSON.parse(payload) as { kind?: string; endpoint?: { type?: string; subtype?: string } })
      .filter((payload) => payload.kind === "logseq-endpoint");

    expect(encrypted.ledger.decisions["typed-endpoint-promoted"]).toBe(2);
    expect(endpointPayloads.map((payload) => payload.endpoint)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "organization" }),
      expect.objectContaining({ type: "occurrence", subtype: "meeting", occurred_on: "unknown" })
    ]));
    expect(encrypted.ledger.totals.quarantine_objects).toBe(0);
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Org Alias");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Meeting Alias");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Cluster");
  });

  it("promotes high-confidence property-derived typed edges", async () => {
    const files = [
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Person.md",
        markdown: "type:: person\nlocation:: [[Synthetic City]]\norg:: [[Synthetic Primary Org]]\nemployer-current:: [[Synthetic Employer]]\nspouse:: [[Synthetic Spouse]]\nestranged-from:: [[Synthetic Estranged Person]]\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Org.md",
        markdown: "type:: org\nheadquarters:: [[Synthetic City]]\nacquired-by:: [[Synthetic Acquirer]]\ncustomer-of:: [[Synthetic Vendor]]\ntags:: [[Synthetic Former Employee]]-employer-past, [[Synthetic Alum]]-education, [[Synthetic Customer]]-revenue, [[Synthetic Member]]-cohort, [[Synthetic Advisor]]-advisory-past, [[Synthetic Weak Tie]]-adjacent\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Meeting.md",
        markdown: "type:: meeting\nlocation:: [[Synthetic Room]]\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Topic.md",
        markdown: "type:: topic\nparent-topic:: [[Synthetic Parent Topic]]\n\n- body text\n",
        source_kind: "logseq" as const
      }
    ];
    const plaintextPayloads: string[] = [];

    const encrypted = await createLogseqSemanticGraphObjects(files, {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001",
      encrypt: async ({ plaintext, aad }) => {
        plaintextPayloads.push(plaintext);
        return {
          ciphertext: Buffer.from(`sealed:${aad}:${plaintext.length}`).toString("base64"),
          nonce: "fixture-semantic-nonce",
          hash: sha256(`sealed:${aad}:${plaintext.length}`),
          algorithm: "fixture-aes-gcm"
        };
      }
    });
    const edgePayloads = plaintextPayloads
      .map((payload) => JSON.parse(payload) as { kind?: string; edge?: { predicate?: string; source_type?: string; target_type?: string; attrs?: Record<string, unknown> } })
      .filter((payload) => payload.kind === "logseq-temporal-edge");

    expect(encrypted.ledger.decisions["typed-endpoint-promoted"]).toBe(4);
    expect(encrypted.ledger.decisions["property-edge-promoted"]).toBe(15);
    expect(encrypted.ledger.decisions["suffix-tag-weak-tie-needs-note"]).toBe(1);
    expect(encrypted.ledger.totals.edge_candidates).toBe(16);
    expect(encrypted.ledger.totals.valid_edge_candidates).toBe(15);
    expect(encrypted.ledger.totals.quarantined_edge_candidates).toBe(1);
    expect(encrypted.ledger.totals.quarantine_objects).toBe(1);
    expect(edgePayloads.map((payload) => payload.edge)).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: "based-in", source_type: "person", target_type: "location" }),
      expect.objectContaining({ predicate: "based-in", source_type: "organization", target_type: "location" }),
      expect.objectContaining({ predicate: "employed-by", source_type: "person", target_type: "organization" }),
      expect.objectContaining({ predicate: "spouse-of", source_type: "person", target_type: "person" }),
      expect.objectContaining({ predicate: "estranged-from", source_type: "person", target_type: "person" }),
      expect.objectContaining({ predicate: "acquired-by", source_type: "organization", target_type: "organization" }),
      expect.objectContaining({ predicate: "customer-of", source_type: "organization", target_type: "organization" }),
      expect.objectContaining({ predicate: "alumnus-of", source_type: "person", target_type: "organization" }),
      expect.objectContaining({ predicate: "member-of", source_type: "person", target_type: "organization" }),
      expect.objectContaining({ predicate: "advises", source_type: "person", target_type: "organization", status: "ended" }),
      expect.objectContaining({ predicate: "occurred-at", source_type: "occurrence", target_type: "location" }),
      expect.objectContaining({ predicate: "part-of-topic", source_type: "topic", target_type: "topic" })
    ]));
    expect(edgePayloads.every((payload) => typeof payload.edge?.attrs?.source_value_hash === "string")).toBe(true);
    expect(edgePayloads.some((payload) => payload.edge?.predicate === "employed-by" && payload.edge.attrs?.property_key === "org")).toBe(true);
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic City");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Primary Org");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Former Employee");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Weak Tie");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Parent Topic");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Room");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Weak Tie");
  });

  it("quarantines non-wikilink relationship property targets for encrypted review", async () => {
    const files = [
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Plain Person.md",
        markdown: "type:: person\nlocation:: Synthetic City\norg:: Synthetic Employer\nspouse:: Synthetic Spouse\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Plain Org.md",
        markdown: "type:: organization\nheadquarters:: Synthetic HQ\ncustomer-of:: Synthetic Customer\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Plain Meeting.md",
        markdown: "type:: meeting\nlocation:: Synthetic Room\nparticipants:: Synthetic Attendee\nproject:: Synthetic Project\n\n- body text\n",
        source_kind: "logseq" as const
      }
    ];

    const encrypted = await createLogseqSemanticGraphObjects(files, {
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

    expect(encrypted.ledger.decisions["typed-endpoint-promoted"]).toBe(3);
    expect(encrypted.ledger.decisions["non-wikilink-location-review"]).toBe(3);
    expect(encrypted.ledger.decisions["non-wikilink-organization-review"]).toBe(2);
    expect(encrypted.ledger.decisions["non-wikilink-person-review"]).toBe(1);
    expect(encrypted.ledger.decisions["non-wikilink-participant-review"]).toBe(1);
    expect(encrypted.ledger.decisions["non-wikilink-project-review"]).toBe(1);
    expect(encrypted.ledger.decisions["property-edge-promoted"]).toBeUndefined();
    expect(encrypted.ledger.totals.edge_candidates).toBe(8);
    expect(encrypted.ledger.totals.valid_edge_candidates).toBe(0);
    expect(encrypted.ledger.totals.quarantined_edge_candidates).toBe(8);
    expect(encrypted.ledger.totals.quarantine_objects).toBe(8);
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Employer");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Room");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Attendee");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Project");
  });

  it("promotes exact non-wikilink property targets only when they match a unique typed endpoint title", async () => {
    const files = [
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic City.md",
        markdown: "type:: location\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Employer.md",
        markdown: "type:: organization\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Exact Person.md",
        markdown: "type:: person\nlocation:: Synthetic City\norg:: Synthetic Employer\nspouse:: Synthetic Unknown Spouse\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Wrong Type Person.md",
        markdown: "type:: person\nlocation:: Synthetic Employer\n\n- body text\n",
        source_kind: "logseq" as const
      }
    ];
    const plaintextPayloads: string[] = [];

    const encrypted = await createLogseqSemanticGraphObjects(files, {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001",
      encrypt: async ({ plaintext, aad }) => {
        plaintextPayloads.push(plaintext);
        return {
          ciphertext: Buffer.from(`sealed:${aad}:${plaintext.length}`).toString("base64"),
          nonce: "fixture-semantic-nonce",
          hash: sha256(`sealed:${aad}:${plaintext.length}`),
          algorithm: "fixture-aes-gcm"
        };
      }
    });
    const edgePayloads = plaintextPayloads
      .map((payload) => JSON.parse(payload) as { kind?: string; edge?: { predicate?: string; target_type?: string; attrs?: Record<string, unknown> } })
      .filter((payload) => payload.kind === "logseq-temporal-edge");

    expect(encrypted.ledger.decisions["typed-endpoint-promoted"]).toBe(4);
    expect(encrypted.ledger.decisions["property-edge-promoted"]).toBe(2);
    expect(encrypted.ledger.decisions["non-wikilink-organization-review"]).toBeUndefined();
    expect(encrypted.ledger.decisions["non-wikilink-location-review"]).toBe(1);
    expect(encrypted.ledger.decisions["non-wikilink-person-review"]).toBe(1);
    expect(encrypted.ledger.totals.edge_candidates).toBe(4);
    expect(encrypted.ledger.totals.valid_edge_candidates).toBe(2);
    expect(encrypted.ledger.totals.quarantined_edge_candidates).toBe(2);
    expect(encrypted.ledger.totals.quarantine_objects).toBe(2);
    expect(edgePayloads.map((payload) => payload.edge)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        predicate: "based-in",
        target_type: "location",
        attrs: expect.objectContaining({ target_resolution: "exact-typed-title" })
      }),
      expect.objectContaining({
        predicate: "employed-by",
        target_type: "organization",
        attrs: expect.objectContaining({ target_resolution: "exact-typed-title" })
      })
    ]));
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic City");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Employer");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Unknown Spouse");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Exact Person");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Wrong Type Person");
  });

  it("promotes exact non-wikilink aliases only when one typed endpoint owns the alias", async () => {
    const files = [
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Alias City.md",
        markdown: "type:: location\nalias:: Synthetic Metro\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Alias Employer.md",
        markdown: "type:: organization\naliases:: Synthetic Alias Org\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Alias Person.md",
        markdown: "type:: person\nlocation:: Synthetic Metro\norg:: Synthetic Alias Org\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Duplicate Org A.md",
        markdown: "type:: organization\nalias:: Shared Synthetic Alias\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Duplicate Org B.md",
        markdown: "type:: organization\nalias:: Shared Synthetic Alias\n\n- body text\n",
        source_kind: "logseq" as const
      },
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Duplicate Alias Person.md",
        markdown: "type:: person\norg:: Shared Synthetic Alias\n\n- body text\n",
        source_kind: "logseq" as const
      }
    ];
    const plaintextPayloads: string[] = [];

    const encrypted = await createLogseqSemanticGraphObjects(files, {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: "fixture-path-redaction-secret-0001",
      encrypt: async ({ plaintext, aad }) => {
        plaintextPayloads.push(plaintext);
        return {
          ciphertext: Buffer.from(`sealed:${aad}:${plaintext.length}`).toString("base64"),
          nonce: "fixture-semantic-nonce",
          hash: sha256(`sealed:${aad}:${plaintext.length}`),
          algorithm: "fixture-aes-gcm"
        };
      }
    });
    const edgePayloads = plaintextPayloads
      .map((payload) => JSON.parse(payload) as { kind?: string; edge?: { predicate?: string; target_type?: string; attrs?: Record<string, unknown> } })
      .filter((payload) => payload.kind === "logseq-temporal-edge");

    expect(encrypted.ledger.decisions["typed-endpoint-promoted"]).toBe(6);
    expect(encrypted.ledger.decisions["property-edge-promoted"]).toBe(2);
    expect(encrypted.ledger.decisions["non-wikilink-location-review"]).toBeUndefined();
    expect(encrypted.ledger.decisions["non-wikilink-organization-review"]).toBe(1);
    expect(encrypted.ledger.totals.edge_candidates).toBe(3);
    expect(encrypted.ledger.totals.valid_edge_candidates).toBe(2);
    expect(encrypted.ledger.totals.quarantined_edge_candidates).toBe(1);
    expect(encrypted.ledger.totals.quarantine_objects).toBe(1);
    expect(edgePayloads.map((payload) => payload.edge)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        predicate: "based-in",
        target_type: "location",
        attrs: expect.objectContaining({ target_resolution: "exact-typed-alias" })
      }),
      expect.objectContaining({
        predicate: "employed-by",
        target_type: "organization",
        attrs: expect.objectContaining({ target_resolution: "exact-typed-alias" })
      })
    ]));
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Metro");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Shared Synthetic Alias");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Alias Org");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Duplicate Alias Person");
  });

  it("promotes approved private review resolutions without exposing target plaintext", async () => {
    const pathRedactionSecret = "fixture-path-redaction-secret-0001";
    const locationTargetHash = createLogseqSemanticReviewTargetHash({
      pathRedactionSecret,
      reasonCode: "non-wikilink-location-review",
      value: "Synthetic Unresolved Place"
    });
    const organizationTargetHash = createLogseqSemanticReviewTargetHash({
      pathRedactionSecret,
      reasonCode: "non-wikilink-organization-review",
      value: "Synthetic Unresolved Org"
    });
    const personTargetHash = createLogseqSemanticReviewTargetHash({
      pathRedactionSecret,
      reasonCode: "non-wikilink-person-review",
      value: "Synthetic Deferred Person"
    });
    const files = [
      {
        source_path: "/tmp/living-atlas-fixtures/Synthetic Review Person.md",
        markdown: "type:: person\nlocation:: Synthetic Unresolved Place\norg:: Synthetic Unresolved Org\nspouse:: Synthetic Deferred Person\n\n- body text\n",
        source_kind: "logseq" as const
      }
    ];
    const plaintextPayloads: string[] = [];

    const encrypted = await createLogseqSemanticGraphObjects(files, {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret,
      review_resolutions: [
        {
          target_hash: locationTargetHash,
          reason_code: "non-wikilink-location-review",
          decision: "map-to-endpoint",
          endpoint_type: "location",
          endpoint_title: "Synthetic Canonical Place",
          aliases: [],
          confidence: "high"
        },
        {
          target_hash: organizationTargetHash,
          reason_code: "non-wikilink-organization-review",
          decision: "create-endpoint",
          endpoint_type: "organization",
          endpoint_title: "Synthetic Canonical Org",
          aliases: [],
          confidence: "high"
        },
        {
          target_hash: personTargetHash,
          reason_code: "non-wikilink-person-review",
          decision: "defer",
          aliases: [],
          confidence: "high"
        }
      ],
      encrypt: async ({ plaintext, aad }) => {
        plaintextPayloads.push(plaintext);
        return {
          ciphertext: Buffer.from(`sealed:${aad}:${plaintext.length}`).toString("base64"),
          nonce: "fixture-semantic-nonce",
          hash: sha256(`sealed:${aad}:${plaintext.length}`),
          algorithm: "fixture-aes-gcm"
        };
      }
    });
    const edgePayloads = plaintextPayloads
      .map((payload) => JSON.parse(payload) as { kind?: string; edge?: { predicate?: string; target_type?: string; attrs?: Record<string, unknown> } })
      .filter((payload) => payload.kind === "logseq-temporal-edge");
    const endpointPayloads = plaintextPayloads
      .map((payload) => JSON.parse(payload) as { kind?: string; review_target_hash?: string; endpoint?: { type?: string; name?: string } })
      .filter((payload) => payload.kind === "logseq-endpoint");

    expect(encrypted.ledger.decisions["typed-endpoint-promoted"]).toBe(1);
    expect(encrypted.ledger.decisions["review-endpoint-created"]).toBe(1);
    expect(encrypted.ledger.decisions["property-edge-promoted"]).toBe(2);
    expect(encrypted.ledger.decisions["non-wikilink-location-review"]).toBeUndefined();
    expect(encrypted.ledger.decisions["non-wikilink-organization-review"]).toBeUndefined();
    expect(encrypted.ledger.decisions["non-wikilink-person-review"]).toBe(1);
    expect(encrypted.ledger.files[0]!.review_status).toBe("reviewed");
    expect(encrypted.ledger.totals.edge_candidates).toBe(3);
    expect(encrypted.ledger.totals.valid_edge_candidates).toBe(2);
    expect(encrypted.ledger.totals.quarantined_edge_candidates).toBe(1);
    expect(encrypted.ledger.totals.quarantine_objects).toBe(1);
    expect(edgePayloads.map((payload) => payload.edge)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        predicate: "based-in",
        target_type: "location",
        attrs: expect.objectContaining({
          target_resolution: "review-resolution",
          review_target_hash: locationTargetHash
        })
      }),
      expect.objectContaining({
        predicate: "employed-by",
        target_type: "organization",
        attrs: expect.objectContaining({
          target_resolution: "review-resolution",
          review_target_hash: organizationTargetHash
        })
      })
    ]));
    expect(endpointPayloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        review_target_hash: organizationTargetHash,
        endpoint: expect.objectContaining({ type: "organization", name: "Synthetic Canonical Org" })
      })
    ]));
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Unresolved Place");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Unresolved Org");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Deferred Person");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Unresolved Place");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Unresolved Org");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Deferred Person");
  });

  it("keeps explicit defer decisions quarantined but marks the file reviewed", async () => {
    const pathRedactionSecret = "fixture-path-redaction-secret-0001";
    const personTargetHash = createLogseqSemanticReviewTargetHash({
      pathRedactionSecret,
      reasonCode: "non-wikilink-person-review",
      value: "Synthetic Deferred Person"
    });
    const file = {
      source_path: "/tmp/living-atlas-fixtures/Synthetic Deferred Person Review.md",
      markdown: "type:: person\nspouse:: Synthetic Deferred Person\n\n- body text\n",
      source_kind: "logseq" as const
    };

    const encrypted = await createLogseqSemanticGraphObjects([file], {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret,
      review_resolutions: [
        {
          target_hash: personTargetHash,
          reason_code: "non-wikilink-person-review",
          decision: "defer",
          aliases: [],
          confidence: "high"
        }
      ],
      encrypt: async ({ plaintext, aad }) => ({
        ciphertext: Buffer.from(`sealed:${aad}:${plaintext.length}`).toString("base64"),
        nonce: "fixture-semantic-nonce",
        hash: sha256(`sealed:${aad}:${plaintext.length}`),
        algorithm: "fixture-aes-gcm"
      })
    });

    expect(encrypted.ledger.decisions["non-wikilink-person-review"]).toBe(1);
    expect(encrypted.ledger.files[0]!.review_status).toBe("reviewed");
    expect(encrypted.ledger.totals.valid_edge_candidates).toBe(0);
    expect(encrypted.ledger.totals.quarantined_edge_candidates).toBe(1);
    expect(encrypted.ledger.totals.quarantine_objects).toBe(1);
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Deferred Person");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Deferred Person");
  });

  it("rejects duplicate non-deferred private review resolutions for the same target hash", async () => {
    const pathRedactionSecret = "fixture-path-redaction-secret-0001";
    const targetHash = createLogseqSemanticReviewTargetHash({
      pathRedactionSecret,
      reasonCode: "non-wikilink-location-review",
      value: "Synthetic Unresolved Place"
    });
    const file = {
      source_path: "/tmp/living-atlas-fixtures/Synthetic Review Person.md",
      markdown: "type:: person\nlocation:: Synthetic Unresolved Place\n\n- body text\n",
      source_kind: "logseq" as const
    };

    await expect(createLogseqSemanticGraphObjects([file], {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret,
      review_resolutions: [
        {
          target_hash: targetHash,
          reason_code: "non-wikilink-location-review",
          decision: "map-to-endpoint",
          endpoint_type: "location",
          endpoint_title: "Synthetic Canonical Place",
          aliases: [],
          confidence: "high"
        },
        {
          target_hash: targetHash,
          reason_code: "non-wikilink-location-review",
          decision: "map-to-endpoint",
          endpoint_type: "location",
          endpoint_title: "Synthetic Alternate Place",
          aliases: [],
          confidence: "high"
        }
      ],
      encrypt: async ({ plaintext, aad }) => ({
        ciphertext: Buffer.from(`sealed:${aad}:${plaintext.length}`).toString("base64"),
        nonce: "fixture-semantic-nonce",
        hash: sha256(`sealed:${aad}:${plaintext.length}`),
        algorithm: "fixture-aes-gcm"
      })
    })).rejects.toThrow(`duplicate semantic review resolution for ${targetHash}`);
  });

  it("does not promote a private review resolution with a mismatched reason code", async () => {
    const pathRedactionSecret = "fixture-path-redaction-secret-0001";
    const targetHash = createLogseqSemanticReviewTargetHash({
      pathRedactionSecret,
      reasonCode: "non-wikilink-location-review",
      value: "Synthetic Unresolved Place"
    });
    const file = {
      source_path: "/tmp/living-atlas-fixtures/Synthetic Review Person.md",
      markdown: "type:: person\nlocation:: Synthetic Unresolved Place\n\n- body text\n",
      source_kind: "logseq" as const
    };

    const encrypted = await createLogseqSemanticGraphObjects([file], {
      authority_id: fixtureAuthorityId,
      created_at: "2026-06-22T12:00:00.000Z",
      path_redaction_secret: pathRedactionSecret,
      review_resolutions: [
        {
          target_hash: targetHash,
          reason_code: "non-wikilink-organization-review",
          decision: "map-to-endpoint",
          endpoint_type: "location",
          endpoint_title: "Synthetic Canonical Place",
          aliases: [],
          confidence: "high"
        }
      ],
      encrypt: async ({ plaintext, aad }) => ({
        ciphertext: Buffer.from(`sealed:${aad}:${plaintext.length}`).toString("base64"),
        nonce: "fixture-semantic-nonce",
        hash: sha256(`sealed:${aad}:${plaintext.length}`),
        algorithm: "fixture-aes-gcm"
      })
    });

    expect(encrypted.ledger.decisions["property-edge-promoted"]).toBeUndefined();
    expect(encrypted.ledger.decisions["non-wikilink-location-review"]).toBe(1);
    expect(encrypted.ledger.totals.valid_edge_candidates).toBe(0);
    expect(encrypted.ledger.totals.quarantined_edge_candidates).toBe(1);
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Unresolved Place");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Unresolved Place");
  });

  it("quarantines cluster endpoints instead of promoting temporal edge objects", async () => {
    const file = {
      source_path: "/tmp/living-atlas-fixtures/Cluster Endpoint.md",
      markdown: "## Edges\n\n- [[Avery North]] (person) member-of [[Inner Circle]] (cluster) from 2026\n",
      source_kind: "logseq" as const
    };

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

    expect(encrypted.ledger.totals.edge_candidates).toBe(1);
    expect(encrypted.ledger.totals.valid_edge_candidates).toBe(0);
    expect(encrypted.ledger.totals.quarantined_edge_candidates).toBe(1);
    expect(encrypted.ledger.totals.quarantine_objects).toBe(1);
    expect(encrypted.ledger.decisions["typed-edge-promoted"]).toBeUndefined();
    expect(encrypted.ledger.decisions["invalid-endpoint-type"]).toBe(1);
    expect(encrypted.ledger.files[0]!.objects).toContainEqual(expect.objectContaining({
      semantic_kind: "edge-candidate",
      access_class: "quarantine",
      decision: "quarantined",
      reason_code: "invalid-endpoint-type"
    }));
    expect(encrypted.ledger.files[0]!.objects).not.toContainEqual(expect.objectContaining({
      semantic_kind: "typed-edge"
    }));
    expect(encrypted.objects).not.toContainEqual(expect.objectContaining({
      visible_metadata: expect.objectContaining({
        schema_namespace: "import/logseq-semantic/typed-edge"
      })
    }));
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Avery North");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Inner Circle");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Avery North");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Inner Circle");
  });

  it("promotes explicit occurrence typed edge lines into encrypted temporal edge objects", async () => {
    const file = {
      source_path: "/tmp/living-atlas-fixtures/Occurrence Edge.md",
      markdown: "## Edges\n\n- [[Person A]] (person) participant-in [[Synthetic Planning Meeting]] (occurrence) from 2026-06-21\n",
      source_kind: "logseq" as const
    };

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

    expect(encrypted.ledger.totals.edge_candidates).toBe(1);
    expect(encrypted.ledger.totals.valid_edge_candidates).toBe(1);
    expect(encrypted.ledger.totals.quarantine_objects).toBe(0);
    expect(encrypted.ledger.decisions["typed-edge-promoted"]).toBe(1);
    expect(encrypted.ledger.files[0]!.objects).toContainEqual(expect.objectContaining({
      semantic_kind: "typed-edge",
      object_type: "edge",
      decision: "captured-encrypted",
      plaintext_in_plan: false
    }));
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Person A");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Planning Meeting");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Person A");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Planning Meeting");
  });

  it("promotes explicit topic typed edge lines into encrypted temporal edge objects", async () => {
    const file = {
      source_path: "/tmp/living-atlas-fixtures/Topic Edge.md",
      markdown: "## Edges\n\n- [[Synthetic Market Theme]] (topic) discussed-at [[Synthetic Planning Meeting]] (occurrence) from 2026-06-21\n",
      source_kind: "logseq" as const
    };

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

    expect(encrypted.ledger.totals.edge_candidates).toBe(1);
    expect(encrypted.ledger.totals.valid_edge_candidates).toBe(1);
    expect(encrypted.ledger.totals.quarantine_objects).toBe(0);
    expect(encrypted.ledger.decisions["typed-edge-promoted"]).toBe(1);
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Market Theme");
    expect(JSON.stringify(encrypted.ledger)).not.toContain("Synthetic Planning Meeting");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Market Theme");
    expect(JSON.stringify(encrypted.objects)).not.toContain("Synthetic Planning Meeting");
  });
});
