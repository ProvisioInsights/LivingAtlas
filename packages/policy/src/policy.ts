import type {
  AccessMode,
  AccessClass,
  CapabilityGrant,
  GraphObjectEnvelope,
  McpProfile,
  Operation
} from "@living-atlas/contracts";
import {
  AdminOperations,
  GraphMutationOperations,
  GraphReadOperations,
  isRemoteReadableAccessClass
} from "@living-atlas/contracts";

export type PolicyRequest = {
  profile: McpProfile;
  operation: Operation;
  actor_id: string;
  access_mode?: AccessMode;
  cloud_unlock_active?: boolean;
  now?: string;
  capability?: CapabilityGrant;
};

export type PolicyReasonCode =
  | "allowed"
  | "missing-capability"
  | "capability-expired"
  | "capability-revoked"
  | "capability-actor-mismatch"
  | "capability-profile-mismatch"
  | "capability-operation-denied"
  | "capability-access-class-denied"
  | "remote-sensitive-unavailable"
  | "cloud-unlock-required"
  | "cloud-unlock-mutation-denied"
  | "cloud-unlock-quarantine-denied"
  | "release-expired"
  | "quarantine-denied"
  | "readonly-denied"
  | "sync-plaintext-denied"
  | "admin-required"
  | "profile-operation-denied";

export type PolicyDecision = {
  allowed: boolean;
  reason_code: PolicyReasonCode;
  response_mode: "normal" | "generic-unavailable" | "redacted-audit";
  plaintext_allowed: boolean;
  requires_ciphertext: boolean;
};

export type RemoteSafeObject = {
  object_id: string;
  object_type: GraphObjectEnvelope["object_type"];
  version: number;
  access_class: Extract<AccessClass, "remote-safe" | "shareable" | "release">;
  visible_metadata: GraphObjectEnvelope["visible_metadata"];
  payload?: Extract<GraphObjectEnvelope["payload"], { kind: "plaintext-json" }>;
};

export type SyncSafeObject = {
  object_id: string;
  object_type: GraphObjectEnvelope["object_type"];
  version: number;
  access_class: AccessClass;
  visible_metadata: GraphObjectEnvelope["visible_metadata"];
  payload?: Extract<GraphObjectEnvelope["payload"], { kind: "ciphertext-ref" | "ciphertext-inline" }>;
  plaintext_withheld: boolean;
};

export type FilteredResult = {
  objects: RemoteSafeObject[];
  withheld_count: number;
};

export type SyncFilteredResult = {
  objects: SyncSafeObject[];
  withheld_count: number;
};

const RemoteAllowedOperations = new Set<Operation>([
  "read",
  "search",
  "traverse",
  "create",
  "update",
  "delete",
  "restore",
  "audit-read"
]);
const CloudUnlockAllowedOperations = new Set<Operation>(["read", "search", "traverse", "decrypt", "audit-read"]);
const LocalReadonlyAllowedOperations = new Set<Operation>(["read", "search", "traverse", "decrypt", "audit-read"]);
const LocalGraphAllowedOperations = new Set<Operation>([
  "read",
  "search",
  "traverse",
  "create",
  "update",
  "delete",
  "restore",
  "decrypt",
  "audit-read"
]);
const SyncAllowedOperations = new Set<Operation>(["sync-read", "sync-write", "audit-read"]);

function isExpired(timestamp: string | undefined, now: string): boolean {
  return timestamp !== undefined && Date.parse(timestamp) <= Date.parse(now);
}

function denied(reason_code: PolicyReasonCode, response_mode: PolicyDecision["response_mode"] = "normal"): PolicyDecision {
  return {
    allowed: false,
    reason_code,
    response_mode,
    plaintext_allowed: false,
    requires_ciphertext: false
  };
}

function allowed(options: Pick<PolicyDecision, "plaintext_allowed" | "requires_ciphertext">): PolicyDecision {
  return {
    allowed: true,
    reason_code: "allowed",
    response_mode: "normal",
    ...options
  };
}

function requestAccessMode(request: PolicyRequest): AccessMode {
  return request.access_mode ?? request.capability?.access_mode ?? (
    request.profile === "remote-cloud-unlock"
      ? "cloud-unlock-session"
      : request.profile === "remote-safe" || request.profile === "sync-device"
        ? "remote-safe-only"
        : "local-keyholding-only"
  );
}

function checkCapability(request: PolicyRequest, object: GraphObjectEnvelope, now: string): PolicyDecision | undefined {
  const { capability } = request;
  if (!capability) {
    return denied("missing-capability", "generic-unavailable");
  }

  if (capability.client_id !== request.actor_id) {
    return denied("capability-actor-mismatch", "generic-unavailable");
  }

  if (capability.revoked_at) {
    return denied("capability-revoked", "generic-unavailable");
  }

  if (isExpired(capability.expires_at, now)) {
    return denied("capability-expired", "generic-unavailable");
  }

  if (capability.profile !== request.profile) {
    return denied("capability-profile-mismatch", "generic-unavailable");
  }

  const accessMode = requestAccessMode(request);
  if (capability.access_mode !== accessMode) {
    return denied("capability-profile-mismatch", "generic-unavailable");
  }

  if (!capability.operations.includes(request.operation)) {
    return denied("capability-operation-denied", "generic-unavailable");
  }

  if (!capability.access_classes.includes(object.access_class)) {
    return denied("capability-access-class-denied", "generic-unavailable");
  }

  return undefined;
}

export function evaluatePolicy(request: PolicyRequest, object: GraphObjectEnvelope): PolicyDecision {
  const now = request.now ?? new Date().toISOString();
  const capabilityDecision = checkCapability(request, object, now);
  if (capabilityDecision) {
    return capabilityDecision;
  }

  if (request.profile === "sync-device") {
    if (!SyncAllowedOperations.has(request.operation)) {
      return denied("sync-plaintext-denied", "generic-unavailable");
    }

    return allowed({
      plaintext_allowed: false,
      requires_ciphertext: true
    });
  }

  if (object.access_class === "quarantine" && request.profile !== "local-admin") {
    return denied("quarantine-denied", request.profile === "remote-safe" ? "generic-unavailable" : "redacted-audit");
  }

  if (object.access_class === "release" && isExpired(object.visible_metadata.release_expires_at, now)) {
    return denied("release-expired", request.profile === "remote-safe" ? "generic-unavailable" : "redacted-audit");
  }

  if (request.profile === "remote-safe") {
    if (!RemoteAllowedOperations.has(request.operation)) {
      return denied("profile-operation-denied", "generic-unavailable");
    }

    if (!isRemoteReadableAccessClass(object.access_class)) {
      return denied("remote-sensitive-unavailable", "generic-unavailable");
    }

    return allowed({
      plaintext_allowed: object.payload.kind === "plaintext-json",
      requires_ciphertext: false
    });
  }

  if (request.profile === "remote-cloud-unlock") {
    if (!CloudUnlockAllowedOperations.has(request.operation)) {
      return denied("cloud-unlock-mutation-denied", "generic-unavailable");
    }

    if (object.access_class === "quarantine") {
      return denied("cloud-unlock-quarantine-denied", "generic-unavailable");
    }

    if (isRemoteReadableAccessClass(object.access_class)) {
      return allowed({
        plaintext_allowed: object.payload.kind === "plaintext-json",
        requires_ciphertext: false
      });
    }

    if (requestAccessMode(request) !== "cloud-unlock-session" || !request.cloud_unlock_active) {
      return denied("cloud-unlock-required", "generic-unavailable");
    }

    return allowed({
      plaintext_allowed: true,
      requires_ciphertext: false
    });
  }

  if (request.profile === "local-readonly") {
    if (!LocalReadonlyAllowedOperations.has(request.operation)) {
      return denied("readonly-denied", "redacted-audit");
    }

    return allowed({
      plaintext_allowed: true,
      requires_ciphertext: false
    });
  }

  if (request.profile === "local-full" || request.profile === "local-crud" || request.profile === "sensitive-keyholding-client") {
    if (!LocalGraphAllowedOperations.has(request.operation)) {
      return denied("profile-operation-denied", "redacted-audit");
    }

    return allowed({
      plaintext_allowed: true,
      requires_ciphertext: false
    });
  }

  if (request.profile === "local-release") {
    if (!(GraphReadOperations as readonly string[]).includes(request.operation) && !(GraphMutationOperations as readonly string[]).includes(request.operation)) {
      return denied("profile-operation-denied", "redacted-audit");
    }

    if (object.access_class !== "release" && object.access_class !== "shareable" && object.access_class !== "remote-safe") {
      return denied("remote-sensitive-unavailable", "redacted-audit");
    }

    return allowed({
      plaintext_allowed: true,
      requires_ciphertext: false
    });
  }

  if (request.profile === "local-admin") {
    if ((AdminOperations as readonly string[]).includes(request.operation) || LocalGraphAllowedOperations.has(request.operation)) {
      return allowed({
        plaintext_allowed: true,
        requires_ciphertext: false
      });
    }

    return denied("profile-operation-denied", "redacted-audit");
  }

  return denied("profile-operation-denied", "generic-unavailable");
}

export function sanitizeObjectForProfile(
  profile: McpProfile,
  object: GraphObjectEnvelope,
  capability: CapabilityGrant,
  actorId: string,
  now?: string
): RemoteSafeObject | undefined {
  const decision = evaluatePolicy({ profile, operation: "read", actor_id: actorId, capability, now }, object);
  if (!decision.allowed || profile !== "remote-safe") {
    return undefined;
  }

  const remoteObject: RemoteSafeObject = {
    object_id: object.object_id,
    object_type: object.object_type,
    version: object.version,
    access_class: object.access_class as RemoteSafeObject["access_class"],
    visible_metadata: object.visible_metadata
  };

  if (object.payload.kind === "plaintext-json") {
    remoteObject.payload = object.payload;
  }

  return remoteObject;
}

export function filterRemoteOutput(profile: McpProfile, objects: GraphObjectEnvelope[], capability: CapabilityGrant, actorId: string, now?: string): FilteredResult {
  const filtered: RemoteSafeObject[] = [];
  let withheld_count = 0;

  for (const object of objects) {
    const sanitized = sanitizeObjectForProfile(profile, object, capability, actorId, now);
    if (sanitized) {
      filtered.push(sanitized);
    } else {
      withheld_count += 1;
    }
  }

  return {
    objects: filtered,
    withheld_count
  };
}

export function filterSyncOutput(profile: McpProfile, objects: GraphObjectEnvelope[], capability: CapabilityGrant, actorId: string, now?: string): SyncFilteredResult {
  const filtered: SyncSafeObject[] = [];
  let withheld_count = 0;

  for (const object of objects) {
    const decision = evaluatePolicy({ profile, operation: "sync-read", actor_id: actorId, capability, now }, object);
    if (!decision.allowed || profile !== "sync-device") {
      withheld_count += 1;
      continue;
    }

    const syncObject: SyncSafeObject = {
      object_id: object.object_id,
      object_type: object.object_type,
      version: object.version,
      access_class: object.access_class,
      visible_metadata: object.visible_metadata,
      plaintext_withheld: object.payload.kind === "plaintext-json"
    };

    if (object.payload.kind !== "plaintext-json") {
      syncObject.payload = object.payload;
    }

    filtered.push(syncObject);
  }

  return { objects: filtered, withheld_count };
}
