import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sensitiveBaitRegistry } from "@living-atlas/fixtures";
import {
  DEFAULT_LOCAL_INSTALL_DIR_NAME,
  DEFAULT_LOCAL_PROFILE_NAME,
  LocalProfileEnvelopeSchema,
  buildLocalProfileEnvelope,
  createLocalProfile,
  openLocalProfile,
  openOrCreateLocalProfile,
  resolveLocalProfilePaths
} from "./profile";

const fixedTimestamp = "2026-06-22T12:00:00.000Z";

describe("local install profile", () => {
  it("resolves default profile paths under a synthetic home directory", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "living-atlas-profile-home-"));
    const paths = resolveLocalProfilePaths({ homeDir });

    expect(paths.install_dir).toBe(join(homeDir, DEFAULT_LOCAL_INSTALL_DIR_NAME));
    expect(paths.profiles_dir).toBe(join(homeDir, DEFAULT_LOCAL_INSTALL_DIR_NAME, "profiles"));
    expect(paths.profile_dir).toBe(
      join(homeDir, DEFAULT_LOCAL_INSTALL_DIR_NAME, "profiles", DEFAULT_LOCAL_PROFILE_NAME)
    );
    expect(paths.profile_config_path).toBe(join(paths.profile_dir, "profile.json"));
    expect(paths.control_store_path).toBe(join(paths.profile_dir, "control-store.json"));
  });

  it("rejects unsafe profile names before building paths", () => {
    expect(() => resolveLocalProfilePaths({ homeDir: "/tmp/living-atlas-test", profileName: "../escape" })).toThrow();
    expect(() => resolveLocalProfilePaths({ homeDir: "/tmp/living-atlas-test", profileName: ".hidden" })).toThrow();
  });

  it("creates and opens a non-secret local profile envelope", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "living-atlas-profile-create-"));
    const token = "synthetic-local-mcp-token-0001";
    const passphrase = "synthetic-local-control-passphrase-0001";
    const profile = await createLocalProfile({ homeDir, now: fixedTimestamp });

    const serialized = await readFile(profile.paths.profile_config_path, "utf8");
    expect(serialized).toContain("\"living-atlas-local-profile\"");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(passphrase);
    for (const bait of sensitiveBaitRegistry) {
      expect(serialized).not.toContain(bait.value);
    }

    await expect(openLocalProfile({ homeDir })).resolves.toEqual(profile);
    expect((await stat(profile.paths.profile_config_path)).mode & 0o777).toBe(0o600);
  });

  it("opens an existing profile without rewriting it", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "living-atlas-profile-existing-"));
    const first = await openOrCreateLocalProfile({ homeDir, now: "2026-06-22T12:00:00.000Z" });
    const second = await openOrCreateLocalProfile({ homeDir, now: "2026-06-23T12:00:00.000Z" });

    expect(second).toEqual(first);
    await expect(createLocalProfile({ homeDir, now: "2026-06-24T12:00:00.000Z" })).rejects.toThrow(
      /already exists/
    );
  });

  it("rejects profile envelopes that try to carry local secrets or mismatched paths", () => {
    const profile = buildLocalProfileEnvelope({
      installDir: "/tmp/living-atlas-profile-safe-envelope",
      now: fixedTimestamp
    });
    const unsafeSecret = JSON.parse(JSON.stringify(profile)) as typeof profile;
    unsafeSecret.secrets.local_mcp_token = "synthetic-local-mcp-token-0001" as "not-stored";
    expect(LocalProfileEnvelopeSchema.safeParse(unsafeSecret).success).toBe(false);

    const unsafePath = JSON.parse(JSON.stringify(profile)) as typeof profile;
    unsafePath.storage.control_store.path = "/tmp/control-store.json";
    expect(LocalProfileEnvelopeSchema.safeParse(unsafePath).success).toBe(false);
  });
});
