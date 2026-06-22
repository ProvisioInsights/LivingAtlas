import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { fixtureLocalClientId } from "@living-atlas/fixtures";
import {
  FileLocalControlStore,
  openLocalControlState,
  sealLocalControlState
} from "./control-store";
import { createFixtureLocalControlState } from "./fixture";

describe("encrypted local control store", () => {
  it("round-trips fixture local control state without serializing local credentials in plaintext", async () => {
    const token = "local-control-token-fixture-0001";
    const state = await createFixtureLocalControlState(token);
    const envelope = await sealLocalControlState(state, "fixture-passphrase-0001", {
      iterations: 100_000,
      salt: new Uint8Array(16).fill(1),
      iv: new Uint8Array(12).fill(2)
    });

    const serialized = JSON.stringify(envelope);
    expect(serialized).toContain(state.authority_id);
    expect(serialized).not.toContain(fixtureLocalClientId);
    expect(serialized).not.toContain("la_cap_localfull0001");
    expect(serialized).not.toContain(token);

    await expect(openLocalControlState(envelope, "fixture-passphrase-0001")).resolves.toMatchObject({
      authority_id: state.authority_id,
      control_plane: {
        authority: {
          authority_id: state.authority_id
        }
      },
      local_credentials: [
        expect.objectContaining({
          client_id: fixtureLocalClientId
        })
      ]
    });
  });

  it("rejects the wrong passphrase", async () => {
    const state = await createFixtureLocalControlState("local-control-token-wrong-pass-0001");
    const envelope = await sealLocalControlState(state, "correct-passphrase-0001", {
      iterations: 100_000,
      salt: new Uint8Array(16).fill(3),
      iv: new Uint8Array(12).fill(4)
    });

    await expect(openLocalControlState(envelope, "wrong-passphrase-0001")).rejects.toThrow();
  });

  it("writes and reads an encrypted local store file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "living-atlas-control-store-"));
    const filePath = join(dir, "control-store.json");
    const store = new FileLocalControlStore(filePath);
    const token = "local-control-token-file-0001";
    const state = await createFixtureLocalControlState(token);

    await store.write(state, "file-passphrase-0001");
    const fileContent = await readFile(filePath, "utf8");
    expect(fileContent).not.toContain(fixtureLocalClientId);
    expect(fileContent).not.toContain(token);

    await expect(store.read("file-passphrase-0001")).resolves.toMatchObject({
      authority_id: state.authority_id
    });
  });
});
