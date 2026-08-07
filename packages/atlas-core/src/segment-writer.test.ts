import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalPrivateDirectoryMode, LocalPrivateFileMode, writeAllSync } from "./segment-writer.js";

/**
 * THE SHORT WRITE IS THE POINT.
 *
 * `writeSync` may write fewer bytes than it was handed and report that by
 * returning the count rather than by throwing. Every call site in this repo
 * ignored the return value, so a short write — a full disk, a signal — left a
 * half-written line on disk and told the caller it had succeeded. In an
 * append-only log that half-line is welded into the middle of the file by the
 * next append.
 *
 * A real file will not produce a short write on demand, which is exactly why the
 * write primitive is injectable: a loop nothing can exercise is a loop nobody
 * knows is correct.
 */
const directories: string[] = [];

function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), "atlas-segment-writer-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  while (directories.length > 0) {
    const path = directories.pop();
    if (path !== undefined) rmSync(path, { recursive: true, force: true });
  }
});

describe("writeAllSync", () => {
  it("keeps writing until every byte is on the file, however short each write is", () => {
    const path = join(scratch(), "log.ndjson");
    const handle = openSync(path, "a", LocalPrivateFileMode);
    const line = `${JSON.stringify({ record: "probe", text: "a totally ordinary line" })}\n`;

    let calls = 0;
    try {
      // One byte at a time: the harshest legal behaviour the syscall has.
      writeAllSync(handle, line, (fd, bytes, offset) => {
        calls += 1;
        const written = Buffer.from([bytes[offset] as number]);
        return writeSync(fd, written, 0, 1);
      });
    } finally {
      closeSync(handle);
    }

    expect(calls).toBe(Buffer.byteLength(line, "utf8"));
    expect(readFileSync(path, "utf8")).toBe(line);
  });

  it("resumes at a byte offset, so a multi-byte character is never cut in half", () => {
    const path = join(scratch(), "log.ndjson");
    const handle = openSync(path, "a", LocalPrivateFileMode);
    // Every one of these is multi-byte in UTF-8, so a resume that re-sliced the
    // STRING by the byte count would write a different line than it was given.
    const line = `${JSON.stringify({ record: "probe", text: "Grüße — Ærø 🜁" })}\n`;

    try {
      let toggle = false;
      writeAllSync(handle, line, (fd, bytes, offset, length) => {
        toggle = !toggle;
        const chunk = toggle ? Math.min(3, length) : length;
        return writeSync(fd, bytes, offset, chunk);
      });
    } finally {
      closeSync(handle);
    }

    expect(readFileSync(path, "utf8")).toBe(line);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ record: "probe", text: "Grüße — Ærø 🜁" });
  });

  it("refuses rather than spinning when the file accepts nothing", () => {
    // A zero-byte write that does not throw would loop forever. Telling the
    // caller the record is durable when the file took none of it is the one
    // outcome an append-only log must never produce.
    const path = join(scratch(), "log.ndjson");
    const handle = openSync(path, "a", LocalPrivateFileMode);
    try {
      expect(() => writeAllSync(handle, "anything\n", () => 0)).toThrow(/write stalled/);
    } finally {
      closeSync(handle);
    }
    expect(readFileSync(path, "utf8")).toBe("");
  });
});

describe("the store's local-private modes", () => {
  it("are owner-only, because every file under a store root is content", () => {
    // Exported so the migration plane's sidecars and the MCP audit journal use
    // the store's rule rather than re-typing an octal literal each. The plane
    // re-typed neither and landed its files at 0644.
    expect(LocalPrivateFileMode).toBe(0o600);
    expect(LocalPrivateDirectoryMode).toBe(0o700);
    expect(LocalPrivateFileMode & 0o077).toBe(0);
    expect(LocalPrivateDirectoryMode & 0o077).toBe(0);
  });
});
