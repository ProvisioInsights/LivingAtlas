import { describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { projectLocalGraphObjects } from "./local-graph-adapter";

const now = "2026-06-24T12:00:00.000Z";

describe("local graph workbench projection", () => {
  it("projects readable endpoint and temporal edge payloads while redacting ciphertext-only objects", async () => {
    const endpointObject: GraphObjectEnvelope = {
      schema_version: 1,
      authority_id: "la_authority_fixture0001",
      object_id: "la_object_topic_proj0001",
      object_type: "page",
      version: 1,
      access_class: "remote-safe",
      encryption_class: "plaintext",
      created_at: now,
      updated_at: now,
      content_hash: sha256("endpoint"),
      visible_metadata: {
        schema_namespace: "test/workbench-endpoint",
        tombstone: false,
        remote_indexable: true
      },
      payload: {
        kind: "plaintext-json",
        data: {
          kind: "workbench-endpoint",
          endpoint: {
            object_id: "la_object_topic_proj0001",
            type: "topic",
            subtype: "domain",
            name: "Projection Topic",
            aliases: [],
            access_class: "remote-safe",
            confidence: "high",
            created_at: now,
            updated_at: now,
            controlled: true,
            tags: []
          }
        }
      }
    };

    const edgeObject: GraphObjectEnvelope = {
      schema_version: 1,
      authority_id: "la_authority_fixture0001",
      object_id: "la_object_edge_proj0001",
      object_type: "edge",
      version: 1,
      access_class: "remote-safe",
      encryption_class: "plaintext",
      created_at: now,
      updated_at: now,
      content_hash: sha256("edge"),
      visible_metadata: {
        schema_namespace: "test/workbench-edge",
        tombstone: false,
        remote_indexable: true
      },
      payload: {
        kind: "plaintext-json",
        data: {
          kind: "workbench-edge",
          edge: {
            edge_id: "la_edge_projection0001",
            source_object_id: "la_object_topic_proj0001",
            source_type: "topic",
            target_object_id: "la_object_topic_missing0001",
            target_type: "topic",
            predicate: "related-topic",
            valid_from: "2026",
            status: "active",
            confidence: "high",
            source: "projection-test",
            attrs: {}
          }
        }
      }
    };

    const ciphertextObject: GraphObjectEnvelope = {
      schema_version: 1,
      authority_id: "la_authority_fixture0001",
      object_id: "la_object_secret_proj0001",
      object_type: "page",
      version: 1,
      access_class: "local-private",
      encryption_class: "client-encrypted",
      created_at: now,
      updated_at: now,
      content_hash: sha256("ciphertext"),
      key_ref: "la_key_fixture0001",
      visible_metadata: {
        schema_namespace: "test/secret",
        tombstone: false,
        remote_indexable: false
      },
      payload: {
        kind: "ciphertext-inline",
        ciphertext: "sealed-fixture",
        nonce: "nonce-fixture",
        algorithm: "fixture-only"
      }
    };

    const projection = await projectLocalGraphObjects({
      objects: [endpointObject, edgeObject, ciphertextObject],
      objectLimit: 10
    });

    expect(projection.graph.nodes).toContainEqual(expect.objectContaining({
      object_id: "la_object_topic_proj0001",
      type: "topic",
      name: "Projection Topic"
    }));
    expect(projection.graph.nodes).toContainEqual(expect.objectContaining({
      object_id: "la_object_topic_missing0001",
      subtype: "reference"
    }));
    expect(projection.graph.nodes).toContainEqual(expect.objectContaining({
      object_id: "la_object_secret_proj0001",
      type: "object",
      access_class: "local-private",
      encryption_class: "client-encrypted"
    }));
    expect(projection.graph.edges).toContainEqual(expect.objectContaining({
      edge_id: "la_edge_projection0001",
      predicate: "related-topic"
    }));
    expect(JSON.stringify(projection.graph)).not.toContain("sealed-fixture");
    expect(projection.readablePayloadCount).toBe(2);
  });

  it("prioritizes edge objects and non-attachment objects over newer attachments", async () => {
    const sourceObject = graphObject({
      object_id: "la_object_topic_priority0001",
      object_type: "page",
      updated_at: "2026-06-20T12:00:00.000Z",
      payload: {
        kind: "plaintext-json",
        data: {
          endpoint: {
            object_id: "la_object_topic_priority0001",
            type: "topic",
            subtype: "domain",
            name: "Priority Topic",
            aliases: [],
            access_class: "remote-safe",
            confidence: "high",
            created_at: now,
            updated_at: now,
            controlled: true,
            tags: []
          }
        }
      }
    });
    const edgeObject = graphObject({
      object_id: "la_object_edge_priority0001",
      object_type: "edge",
      updated_at: "2026-06-19T12:00:00.000Z",
      payload: {
        kind: "plaintext-json",
        data: {
          edge: {
            edge_id: "la_edge_priority0001",
            source_object_id: "la_object_topic_priority0001",
            source_type: "topic",
            target_object_id: "la_object_topic_priority0002",
            target_type: "topic",
            predicate: "related-topic",
            valid_from: "2026",
            status: "active",
            confidence: "high",
            source: "priority-test",
            attrs: {}
          }
        }
      }
    });
    const attachmentObject = graphObject({
      object_id: "la_object_attachment_priority0001",
      object_type: "attachment",
      updated_at: "2026-06-24T12:00:00.000Z",
      payload: {
        kind: "plaintext-json",
        data: { kind: "attachment-support-record" }
      }
    });

    const projection = await projectLocalGraphObjects({
      objects: [attachmentObject, sourceObject, edgeObject],
      objectLimit: 2
    });

    expect(projection.graph.edges).toContainEqual(expect.objectContaining({
      edge_id: "la_edge_priority0001"
    }));
    expect(projection.graph.nodes).toContainEqual(expect.objectContaining({
      object_id: "la_object_topic_priority0001",
      name: "Priority Topic"
    }));
    expect(projection.graph.nodes).not.toContainEqual(expect.objectContaining({
      object_id: "la_object_attachment_priority0001"
    }));
  });

  it("pulls named endpoint records for selected edges before unrelated newer objects", async () => {
    const sourceObject = graphObject({
      object_id: "la_object_topic_endpoint0001",
      object_type: "page",
      updated_at: "2026-06-18T12:00:00.000Z",
      payload: {
        kind: "plaintext-json",
        data: {
          endpoint: {
            object_id: "la_object_topic_endpoint0001",
            type: "topic",
            subtype: "domain",
            name: "Named Edge Endpoint",
            aliases: [],
            access_class: "remote-safe",
            confidence: "high",
            created_at: now,
            updated_at: now,
            controlled: true,
            tags: []
          }
        }
      }
    });
    const edgeObject = graphObject({
      object_id: "la_object_edge_endpoint0001",
      object_type: "edge",
      updated_at: "2026-06-24T12:00:00.000Z",
      payload: {
        kind: "plaintext-json",
        data: {
          edge: {
            edge_id: "la_edge_endpoint0001",
            source_object_id: "la_object_topic_endpoint0001",
            source_type: "topic",
            target_object_id: "la_object_topic_missing0001",
            target_type: "topic",
            predicate: "related-topic",
            valid_from: "2026",
            status: "active",
            confidence: "high",
            source: "endpoint-selection-test",
            attrs: {}
          }
        }
      }
    });
    const unrelatedObject = graphObject({
      object_id: "la_object_topic_unrelated0001",
      object_type: "page",
      updated_at: "2026-06-23T12:00:00.000Z",
      payload: {
        kind: "plaintext-json",
        data: {
          endpoint: {
            object_id: "la_object_topic_unrelated0001",
            type: "topic",
            subtype: "domain",
            name: "Newer Unrelated Topic",
            aliases: [],
            access_class: "remote-safe",
            confidence: "high",
            created_at: now,
            updated_at: now,
            controlled: true,
            tags: []
          }
        }
      }
    });

    const projection = await projectLocalGraphObjects({
      objects: [unrelatedObject, sourceObject, edgeObject],
      objectLimit: 2
    });

    expect(projection.graph.edges).toContainEqual(expect.objectContaining({
      edge_id: "la_edge_endpoint0001"
    }));
    expect(projection.graph.nodes).toContainEqual(expect.objectContaining({
      object_id: "la_object_topic_endpoint0001",
      name: "Named Edge Endpoint",
      subtype: "domain"
    }));
    expect(projection.graph.nodes).not.toContainEqual(expect.objectContaining({
      object_id: "la_object_topic_endpoint0001",
      subtype: "reference"
    }));
    expect(projection.graph.nodes).not.toContainEqual(expect.objectContaining({
      object_id: "la_object_topic_unrelated0001"
    }));
  });

  it("derives unresolved target reference labels from local source capsule properties", async () => {
    const sourceObject = graphObject({
      object_id: "la_object_person_capsule0001",
      object_type: "page",
      updated_at: "2026-06-20T12:00:00.000Z",
      payload: {
        kind: "plaintext-json",
        data: {
          endpoint: {
            object_id: "la_object_person_capsule0001",
            type: "person",
            subtype: "individual",
            name: "Capsule Person",
            aliases: [],
            access_class: "remote-safe",
            confidence: "high",
            created_at: now,
            updated_at: now,
            controlled: true,
            tags: []
          }
        }
      }
    });
    const sourceCapsuleObject = graphObject({
      object_id: "la_object_capsule_reference0001",
      object_type: "attachment",
      updated_at: "2026-06-19T12:00:00.000Z",
      payload: {
        kind: "plaintext-json",
        data: {
          kind: "logseq-source-capsule",
          markdown: "type:: person\norg:: [[Readable Target Org]]\n- source note"
        }
      }
    });
    const edgeObject = graphObject({
      object_id: "la_object_edge_capsule0001",
      object_type: "edge",
      updated_at: "2026-06-24T12:00:00.000Z",
      payload: {
        kind: "plaintext-json",
        data: {
          edge: {
            edge_id: "la_edge_capsule0001",
            source_object_id: "la_object_person_capsule0001",
            source_type: "person",
            target_object_id: "la_object_org_capsule_missing0001",
            target_type: "organization",
            predicate: "employed-by",
            valid_from: "2026",
            status: "active",
            confidence: "high",
            source: "capsule-reference-test",
            attrs: {
              source_capsule_object_id: "la_object_capsule_reference0001",
              property_key: "org"
            }
          }
        }
      }
    });
    const unrelatedObject = graphObject({
      object_id: "la_object_topic_capsule_unrelated0001",
      object_type: "page",
      updated_at: "2026-06-23T12:00:00.000Z",
      payload: {
        kind: "plaintext-json",
        data: { kind: "newer-unrelated" }
      }
    });

    const projection = await projectLocalGraphObjects({
      objects: [unrelatedObject, sourceObject, sourceCapsuleObject, edgeObject],
      objectLimit: 2
    });

    expect(projection.graph.nodes).toContainEqual(expect.objectContaining({
      object_id: "la_object_org_capsule_missing0001",
      type: "organization",
      subtype: "reference",
      name: "Readable Target Org",
      confidence: "medium"
    }));
    expect(projection.graph.nodes).not.toContainEqual(expect.objectContaining({
      object_id: "la_object_capsule_reference0001"
    }));
  });
});

function sha256(value: string): `sha256:${string}` {
  const fakeHex = Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
  return `sha256:${fakeHex}`;
}

function graphObject(overrides: Partial<GraphObjectEnvelope>): GraphObjectEnvelope {
  return {
    schema_version: 1,
    authority_id: "la_authority_fixture0001",
    object_id: "la_object_fixture0001",
    object_type: "page",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: sha256(JSON.stringify(overrides)),
    visible_metadata: {
      schema_namespace: "test/workbench-priority",
      tombstone: false,
      remote_indexable: true
    },
    payload: {
      kind: "plaintext-json",
      data: {}
    },
    ...overrides
  } as GraphObjectEnvelope;
}
