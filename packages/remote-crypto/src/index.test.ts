import { describe, expect, it } from "vitest";
import {
  CloudUnlockObjectAlgorithm,
  CloudUnlockEscalatedObjectAlgorithm,
  decryptCloudUnlockObject,
  encryptCloudUnlockObject,
  decryptEscalatedCloudUnlockObject,
  encryptEscalatedCloudUnlockObject
} from "@living-atlas/remote-crypto";

describe("remote-crypto barrel", () => {
  it("re-exports both tier algorithms and round-trips T1", async () => {
    expect(CloudUnlockObjectAlgorithm).toBe("AES-GCM-256+cloud-unlock-v1");
    expect(CloudUnlockEscalatedObjectAlgorithm).toBe("AES-GCM-256+cloud-unlock-escalated-v1");
    expect(typeof decryptCloudUnlockObject).toBe("function");
    expect(typeof encryptCloudUnlockObject).toBe("function");
    expect(typeof decryptEscalatedCloudUnlockObject).toBe("function");
    expect(typeof encryptEscalatedCloudUnlockObject).toBe("function");
  });
});
