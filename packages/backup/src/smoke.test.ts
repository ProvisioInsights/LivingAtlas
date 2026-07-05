import { describe, expect, it } from "vitest";
import { BACKUP_PACKAGE_NAME } from "./index";

describe("backup package", () => {
  it("exposes its package name", () => {
    expect(BACKUP_PACKAGE_NAME).toBe("@living-atlas/backup");
  });
});
