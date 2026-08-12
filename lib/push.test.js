import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldIgnoreRel } from "./ignore.js";
import { resolvePushTargets } from "./push.js";

describe("shouldIgnoreRel", () => {
  const ignore = [".git", "node_modules", ".DS_Store", ".sftp-autosync", "*.tmp", "*.swp"];

  test("ignores meta dir and sync-config.json basename", () => {
    expect(shouldIgnoreRel(".sftp-autosync/status.json", ignore)).toBe(true);
    expect(shouldIgnoreRel("sync-config.json", ignore)).toBe(true);
    expect(shouldIgnoreRel("src/index.js", ignore)).toBe(false);
  });

  test("matches glob basenames", () => {
    expect(shouldIgnoreRel("foo.tmp", ignore)).toBe(true);
    expect(shouldIgnoreRel("dir/x.swp", ignore)).toBe(true);
  });
});

describe("resolvePushTargets", () => {
  test("empty paths lists every non-ignored file", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-push-"));
    try {
      writeFileSync(join(root, "a.txt"), "a");
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "b.txt"), "b");
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "node_modules", "c.txt"), "c");

      const ignore = (rel) => shouldIgnoreRel(rel, ["node_modules", ".sftp-autosync"]);
      const targets = resolvePushTargets(root, [], ignore).sort();
      expect(targets).toEqual([join(root, "a.txt"), join(root, "src", "b.txt")].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("directory path expands to files under it", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-push-dir-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "b.txt"), "b");
      writeFileSync(join(root, "a.txt"), "a");

      const ignore = () => false;
      const targets = resolvePushTargets(root, ["src"], ignore);
      expect(targets).toEqual([join(root, "src", "b.txt")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects paths outside the project", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-push-out-"));
    try {
      expect(() => resolvePushTargets(root, ["../outside"], () => false)).toThrow(
        /outside project/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
