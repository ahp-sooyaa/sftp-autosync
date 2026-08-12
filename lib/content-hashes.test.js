import { describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  breakStaleContentHashLock,
  contentHash,
  hashesLockPath,
  hashesPath,
  loadContentHashes,
  mergeContentHashUpdates,
  saveContentHashes,
  seedContentHashesFromDisk,
  shouldSkipUnchanged,
  uploadedBytesStillMatch,
  withContentHashLock,
} from "./content-hashes.js";
import { shouldIgnoreRel } from "./ignore.js";

describe("content hashes persistence", () => {
  test("round-trips absolute map via relative JSON keys", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-hashes-"));
    try {
      const abs = join(root, "package.json");
      writeFileSync(abs, '{"name":"demo"}\n');
      const hash = contentHash(readFileSync(abs));
      saveContentHashes(root, new Map([[abs, hash]]));

      const loaded = loadContentHashes(root);
      expect(loaded.get(abs)).toBe(hash);
      const raw = JSON.parse(
        readFileSync(join(root, ".sftp-autosync", "content-hashes.json"), "utf8"),
      );
      expect(raw.files["package.json"]).toBe(hash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("saveContentHashes leaves no tmp leftovers", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-atomic-"));
    try {
      const abs = join(root, "a.txt");
      writeFileSync(abs, "a");
      saveContentHashes(root, new Map([[abs, contentHash(Buffer.from("a"))]]));
      expect(existsSync(hashesPath(root))).toBe(true);
      const leftovers = readdirSync(join(root, ".sftp-autosync")).filter((name) =>
        name.endsWith(".tmp"),
      );
      expect(leftovers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("corrupt hash file is quarantined instead of merging as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-corrupt-"));
    try {
      mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
      writeFileSync(hashesPath(root), "{not-json");
      const loaded = loadContentHashes(root);
      expect(loaded.size).toBe(0);
      expect(existsSync(hashesPath(root))).toBe(false);
      const backups = readdirSync(join(root, ".sftp-autosync")).filter((name) =>
        name.includes(".corrupt."),
      );
      expect(backups.length).toBe(1);

      const kept = join(root, "kept.txt");
      mergeContentHashUpdates(root, {
        upserts: new Map([[kept, contentHash(Buffer.from("kept"))]]),
      });
      expect(loadContentHashes(root).get(kept)).toBe(contentHash(Buffer.from("kept")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("breakStaleContentHashLock removes dead-pid locks", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-lock-"));
    try {
      mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
      const lockPath = hashesLockPath(root);
      writeFileSync(lockPath, "999999999\n");
      expect(breakStaleContentHashLock(root)).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("breakStaleContentHashLock does not steal a live-pid lock", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-lock-live-"));
    try {
      mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
      const lockPath = hashesLockPath(root);
      writeFileSync(lockPath, `${process.pid}\n`);
      expect(breakStaleContentHashLock(root)).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("withContentHashLock recovers after a stale empty lock", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-lock-empty-"));
    try {
      mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
      const lockPath = hashesLockPath(root);
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      const past = new Date(Date.now() - 60_000);
      utimesSync(lockPath, past, past);

      const value = withContentHashLock(root, () => 42);
      expect(value).toBe(42);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("seedContentHashesFromDisk hashes non-ignored files only", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-seed-"));
    try {
      writeFileSync(join(root, "index.html"), "<html></html>\n");
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "node_modules", "x.js"), "1");
      mkdirSync(join(root, ".sftp-autosync"));
      writeFileSync(join(root, ".sftp-autosync", "sync-config.json"), "{}");

      const ignore = [".git", "node_modules", ".DS_Store", ".sftp-autosync"];
      const result = seedContentHashesFromDisk(root, (rel) => shouldIgnoreRel(rel, ignore));
      expect(result.count).toBe(1);

      const loaded = loadContentHashes(root);
      expect(loaded.size).toBe(1);
      expect(loaded.has(join(root, "index.html"))).toBe(true);
      expect(loaded.has(join(root, "node_modules", "x.js"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mergeContentHashUpdates keeps unrelated disk fingerprints", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-merge-"));
    try {
      const pkg = join(root, "package.json");
      const index = join(root, "index.html");
      const pkgHash = contentHash(Buffer.from('{"name":"demo"}\n'));
      const indexHash = contentHash(Buffer.from("<html></html>\n"));
      saveContentHashes(
        root,
        new Map([
          [pkg, pkgHash],
          [index, indexHash],
        ]),
      );

      const watcherOnly = contentHash(Buffer.from("<html>changed</html>\n"));
      const merged = mergeContentHashUpdates(root, {
        upserts: new Map([[index, watcherOnly]]),
      });

      expect(merged.get(pkg)).toBe(pkgHash);
      expect(merged.get(index)).toBe(watcherOnly);
      expect(loadContentHashes(root).get(pkg)).toBe(pkgHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mergeContentHashUpdates removes a path without wiping siblings", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-merge-rm-"));
    try {
      const a = join(root, "a.txt");
      const b = join(root, "b.txt");
      saveContentHashes(
        root,
        new Map([
          [a, contentHash(Buffer.from("a"))],
          [b, contentHash(Buffer.from("b"))],
        ]),
      );

      mergeContentHashUpdates(root, { removes: [a] });
      const loaded = loadContentHashes(root);
      expect(loaded.has(a)).toBe(false);
      expect(loaded.get(b)).toBe(contentHash(Buffer.from("b")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("shouldSkipUnchanged / uploadedBytesStillMatch", () => {
  test("skips only when a previous successful-upload hash matches", () => {
    const hash = contentHash(Buffer.from("same"));
    expect(shouldSkipUnchanged(undefined, hash)).toBe(false);
    expect(shouldSkipUnchanged(null, hash)).toBe(false);
    expect(shouldSkipUnchanged(hash, hash)).toBe(true);
    expect(shouldSkipUnchanged(hash, contentHash(Buffer.from("diff")))).toBe(false);
  });

  test("only records a fingerprint when post-upload bytes match pre-upload hash", () => {
    const pre = contentHash(Buffer.from("v1"));
    expect(uploadedBytesStillMatch(pre, pre)).toBe(true);
    expect(uploadedBytesStillMatch(pre, contentHash(Buffer.from("v2")))).toBe(false);
    expect(uploadedBytesStillMatch(pre, null)).toBe(false);
  });
});
