import {
  CanonicalEntityResolutionPayloadSchema,
  type CanonicalEntityResolutionPayload,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import type { CanonicalPayloadDecryptor } from "./canonical-assertions";

export type CanonicalEntityResolutionQuery = {
  known_at?: string;
};

export type CanonicalEntityResolutionProjection = {
  redirects: Record<string, string>;
  active_resolution_ids: string[];
  superseded_resolution_ids: string[];
  invalid_resolution_ids: string[];
};

export type CanonicalEntityRedirect = {
  entity_id: string;
  canonical_entity_id: string;
  redirect_path: string[];
};

type ActiveMerge = {
  redirects: Array<{ source: string; target: string }>;
};

function followsTo(direct: Map<string, string>, start: string, expected: string): boolean {
  const visited = new Set<string>();
  let current = start;
  while (direct.has(current) && !visited.has(current)) {
    if (current === expected) return true;
    visited.add(current);
    current = direct.get(current)!;
  }
  return current === expected;
}

export function projectCanonicalEntityResolutions(
  resolutions: CanonicalEntityResolutionPayload[],
  query: CanonicalEntityResolutionQuery = {}
): CanonicalEntityResolutionProjection {
  const direct = new Map<string, string>();
  const directOwners = new Map<string, string>();
  const activeMerges = new Map<string, ActiveMerge>();
  const superseded = new Set<string>();
  const invalid = new Set<string>();
  const known = resolutions
    .filter((resolution) => !query.known_at || resolution.recorded_at <= query.known_at)
    .slice()
    .sort((left, right) => left.recorded_at.localeCompare(right.recorded_at) || left.resolution_id.localeCompare(right.resolution_id));

  for (const resolution of known) {
    if (resolution.decision === "split") {
      for (const supersededId of resolution.supersedes) {
        superseded.add(supersededId);
        const merge = activeMerges.get(supersededId);
        if (!merge) continue;
        for (const redirect of merge.redirects) {
          if (directOwners.get(redirect.source) === supersededId) {
            direct.delete(redirect.source);
            directOwners.delete(redirect.source);
          }
        }
        activeMerges.delete(supersededId);
      }
      continue;
    }
    const target = resolution.canonical_entity_id;
    if (resolution.decision !== "merge" || !target) continue;

    const distinctCandidateIds = new Set(resolution.candidate_entity_ids);
    const redirects = [...distinctCandidateIds]
      .filter((candidate) => candidate !== resolution.canonical_entity_id)
      .map((source) => ({ source, target }));
    if (distinctCandidateIds.size < 2
      || distinctCandidateIds.size !== resolution.candidate_entity_ids.length
      || redirects.length === 0) {
      invalid.add(resolution.resolution_id);
      continue;
    }
    const candidateDirect = new Map(direct);
    const supersededMerges = resolution.supersedes.flatMap((supersededId) => {
      const merge = activeMerges.get(supersededId);
      return merge ? [{ supersededId, merge }] : [];
    });
    for (const { supersededId, merge } of supersededMerges) {
      for (const redirect of merge.redirects) {
        if (directOwners.get(redirect.source) === supersededId) candidateDirect.delete(redirect.source);
      }
    }
    if (redirects.some((redirect) => candidateDirect.has(redirect.source))) {
      invalid.add(resolution.resolution_id);
      continue;
    }
    for (const redirect of redirects) candidateDirect.set(redirect.source, redirect.target);
    if (redirects.some((redirect) => followsTo(candidateDirect, redirect.target, redirect.source))) {
      invalid.add(resolution.resolution_id);
      continue;
    }
    for (const { supersededId, merge } of supersededMerges) {
      superseded.add(supersededId);
      for (const redirect of merge.redirects) {
        if (directOwners.get(redirect.source) === supersededId) {
          direct.delete(redirect.source);
          directOwners.delete(redirect.source);
        }
      }
      activeMerges.delete(supersededId);
    }
    for (const redirect of redirects) {
      direct.set(redirect.source, redirect.target);
      directOwners.set(redirect.source, resolution.resolution_id);
    }
    activeMerges.set(resolution.resolution_id, { redirects });
  }

  return {
    redirects: Object.fromEntries([...direct.entries()].sort(([left], [right]) => left.localeCompare(right))),
    active_resolution_ids: [...activeMerges.keys()].sort(),
    superseded_resolution_ids: [...superseded].sort(),
    invalid_resolution_ids: [...invalid].sort()
  };
}

export function resolveCanonicalEntityId(
  entityId: string,
  projection: CanonicalEntityResolutionProjection
): CanonicalEntityRedirect {
  const path = [entityId];
  const visited = new Set(path);
  let current = entityId;
  for (;;) {
    const next = projection.redirects[current];
    if (!next || visited.has(next)) break;
    current = next;
    path.push(current);
    visited.add(current);
  }
  return { entity_id: entityId, canonical_entity_id: current, redirect_path: path };
}

export async function loadCanonicalEntityResolutionsFromObjects(
  objects: GraphObjectEnvelope[],
  decryptPayload: CanonicalPayloadDecryptor
): Promise<CanonicalEntityResolutionPayload[]> {
  const resolutions: CanonicalEntityResolutionPayload[] = [];
  const envelopes = objects
    .filter((object) => object.object_type === "review")
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.object_id.localeCompare(right.object_id));
  for (const object of envelopes) {
    const payload = await decryptPayload(object);
    if (!payload) continue;
    const resolution = CanonicalEntityResolutionPayloadSchema.safeParse(payload);
    if (resolution.success) resolutions.push(resolution.data);
  }
  return resolutions;
}
