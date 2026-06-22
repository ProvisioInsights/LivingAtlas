import { describe, expect, it } from "vitest";
import {
  controlPlaneFixture,
  syntheticGraphObjects,
  fixtureCloudUnlockClientId,
  fixtureRemoteClientId,
  fixtureLocalClientId
} from "@living-atlas/fixtures";
import { evaluatePolicy, filterRemoteOutput, filterSyncOutput } from "./index";

const privateObject = syntheticGraphObjects.find((object) => object.access_class === "local-private")!;
const remoteSafeObject = syntheticGraphObjects.find((object) => object.access_class === "remote-safe")!;
const quarantineObject = syntheticGraphObjects.find((object) => object.access_class === "quarantine")!;
const releaseObject = syntheticGraphObjects.find((object) => object.access_class === "release")!;
const remoteCapability = controlPlaneFixture.capabilities.find((capability) => capability.profile === "remote-safe")!;
const cloudUnlockCapability = controlPlaneFixture.capabilities.find((capability) => capability.profile === "remote-cloud-unlock")!;
const localCapability = controlPlaneFixture.capabilities.find((capability) => capability.profile === "local-full")!;
const syncCapability = controlPlaneFixture.capabilities.find((capability) => capability.profile === "sync-device")!;
const adminCapability = controlPlaneFixture.capabilities.find((capability) => capability.profile === "local-admin")!;

describe("evaluatePolicy", () => {
  it("allows remote-safe CRUD only on remote-readable classes", () => {
    expect(
      evaluatePolicy({
        profile: "remote-safe",
        operation: "update",
        actor_id: fixtureRemoteClientId,
        capability: remoteCapability
      }, remoteSafeObject)
    ).toMatchObject({ allowed: true, plaintext_allowed: true });

    expect(
      evaluatePolicy({
        profile: "remote-safe",
        operation: "read",
        actor_id: fixtureRemoteClientId,
        capability: remoteCapability
      }, privateObject)
    ).toMatchObject({
      allowed: false,
      response_mode: "generic-unavailable"
    });
  });

  it("allows local-full access to the full authorized synthetic graph", () => {
    expect(
      evaluatePolicy({
        profile: "local-full",
        operation: "decrypt",
        actor_id: fixtureLocalClientId,
        capability: localCapability
      }, privateObject)
    ).toMatchObject({ allowed: true, plaintext_allowed: true });
  });

  it("models cloud-unlock as an explicit remote sensitive-read session", () => {
    expect(
      evaluatePolicy({
        profile: "remote-safe",
        operation: "decrypt",
        actor_id: fixtureRemoteClientId,
        capability: remoteCapability,
        access_mode: "remote-safe-only"
      }, privateObject)
    ).toMatchObject({
      allowed: false,
      reason_code: "capability-operation-denied"
    });

    expect(
      evaluatePolicy({
        profile: "remote-cloud-unlock",
        operation: "decrypt",
        actor_id: fixtureCloudUnlockClientId,
        capability: cloudUnlockCapability,
        access_mode: "cloud-unlock-session"
      }, privateObject)
    ).toMatchObject({
      allowed: false,
      reason_code: "cloud-unlock-required"
    });

    expect(
      evaluatePolicy({
        profile: "remote-cloud-unlock",
        operation: "decrypt",
        actor_id: fixtureCloudUnlockClientId,
        capability: cloudUnlockCapability,
        access_mode: "cloud-unlock-session",
        cloud_unlock_active: true
      }, privateObject)
    ).toMatchObject({
      allowed: true,
      plaintext_allowed: true,
      requires_ciphertext: false
    });

    expect(
      evaluatePolicy({
        profile: "remote-cloud-unlock",
        operation: "update",
        actor_id: fixtureCloudUnlockClientId,
        capability: cloudUnlockCapability,
        access_mode: "cloud-unlock-session",
        cloud_unlock_active: true
      }, remoteSafeObject)
    ).toMatchObject({
      allowed: false,
      reason_code: "capability-operation-denied"
    });
  });

  it("denies profile-only access without a capability and denies capability actor mismatch", () => {
    expect(
      evaluatePolicy({
        profile: "local-full",
        operation: "decrypt",
        actor_id: fixtureLocalClientId
      }, privateObject)
    ).toMatchObject({ allowed: false, reason_code: "missing-capability" });

    expect(
      evaluatePolicy({
        profile: "local-full",
        operation: "decrypt",
        actor_id: fixtureRemoteClientId,
        capability: localCapability
      }, privateObject)
    ).toMatchObject({ allowed: false, reason_code: "capability-actor-mismatch" });
  });

  it("limits sync devices to ciphertext envelope operations", () => {
    expect(
      evaluatePolicy({
        profile: "sync-device",
        operation: "sync-read",
        actor_id: "la_client_sync0001",
        capability: syncCapability
      }, privateObject)
    ).toMatchObject({ allowed: true, plaintext_allowed: false, requires_ciphertext: true });

    expect(
      evaluatePolicy({
        profile: "sync-device",
        operation: "read",
        actor_id: "la_client_sync0001",
        capability: syncCapability
      }, privateObject)
    ).toMatchObject({ allowed: false, reason_code: "capability-operation-denied" });
  });

  it("keeps quarantine unavailable unless local-admin is explicitly used", () => {
    expect(
      evaluatePolicy({
        profile: "local-full",
        operation: "read",
        actor_id: fixtureLocalClientId,
        capability: localCapability
      }, quarantineObject)
    ).toMatchObject({ allowed: false, reason_code: "quarantine-denied" });

    expect(
      evaluatePolicy({
        profile: "local-admin",
        operation: "read",
        actor_id: "la_client_admin0001",
        capability: adminCapability
      }, quarantineObject)
    ).toMatchObject({ allowed: true });
  });

  it("expires release objects for remote reads", () => {
    expect(
      evaluatePolicy({
        profile: "remote-safe",
        operation: "read",
        actor_id: fixtureRemoteClientId,
        capability: remoteCapability,
        now: "2028-01-01T00:00:00.000Z"
      }, releaseObject)
    ).toMatchObject({ allowed: false, reason_code: "release-expired", response_mode: "generic-unavailable" });
  });
});

describe("filterRemoteOutput", () => {
  it("returns only remote-readable objects and does not identify withheld objects", () => {
    const output = filterRemoteOutput("remote-safe", syntheticGraphObjects, remoteCapability, fixtureRemoteClientId, "2026-06-21T12:00:00.000Z");

    expect(output.objects.map((object) => object.access_class).sort()).toEqual(["release", "remote-safe", "shareable"]);
    expect(output.withheld_count).toBe(3);
    expect(JSON.stringify(output)).not.toContain(privateObject.object_id);
  });
});

describe("filterSyncOutput", () => {
  it("never returns plaintext payloads to sync-device output", () => {
    const output = filterSyncOutput("sync-device", syntheticGraphObjects, syncCapability, "la_client_sync0001", "2026-06-21T12:00:00.000Z");

    expect(output.withheld_count).toBe(0);
    expect(output.objects).toHaveLength(syntheticGraphObjects.length);
    expect(JSON.stringify(output)).not.toContain("Living Atlas public fixture");
    expect(output.objects.some((object) => object.plaintext_withheld)).toBe(true);
  });
});
