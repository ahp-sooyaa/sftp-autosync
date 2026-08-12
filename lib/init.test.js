import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobalConfig, ensureParentDirs } from "./init.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "sftp-autosync-init-"));
}

describe("createGlobalConfig", () => {
  test("creates config.json from example with custom parents", () => {
    const root = tempRoot();
    try {
      const examplePath = join(root, "config.example.json");
      const configPath = join(root, "config.json");
      writeFileSync(
        examplePath,
        JSON.stringify({
          parents: ["~/Sites"],
          debounceMs: 200,
          notify: { enabled: true },
        }),
      );

      const result = createGlobalConfig({
        configPath,
        examplePath,
        parents: ["~/Work", "~/Sites"],
      });

      expect(result.created).toBe(true);
      expect(result.parents).toEqual(["~/Work", "~/Sites"]);
      const written = JSON.parse(readFileSync(configPath, "utf8"));
      expect(written.parents).toEqual(["~/Work", "~/Sites"]);
      expect(written.debounceMs).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is a no-op without --force when config exists", () => {
    const root = tempRoot();
    try {
      const examplePath = join(root, "config.example.json");
      const configPath = join(root, "config.json");
      writeFileSync(examplePath, JSON.stringify({ parents: ["~/Sites"] }));
      writeFileSync(configPath, JSON.stringify({ parents: ["~/Existing"] }));

      const result = createGlobalConfig({
        configPath,
        examplePath,
        parents: ["~/Other"],
        force: false,
      });

      expect(result.created).toBe(false);
      expect(result.parents).toEqual(["~/Existing"]);
      expect(JSON.parse(readFileSync(configPath, "utf8")).parents).toEqual(["~/Existing"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("overwrites from example when force is true", () => {
    const root = tempRoot();
    try {
      const examplePath = join(root, "config.example.json");
      const configPath = join(root, "config.json");
      writeFileSync(examplePath, JSON.stringify({ parents: ["~/Sites"], concurrency: 3 }));
      writeFileSync(configPath, JSON.stringify({ parents: ["~/Old"], concurrency: 9 }));

      const result = createGlobalConfig({
        configPath,
        examplePath,
        parents: ["~/New"],
        force: true,
      });

      expect(result.created).toBe(true);
      const written = JSON.parse(readFileSync(configPath, "utf8"));
      expect(written.parents).toEqual(["~/New"]);
      expect(written.concurrency).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ensureParentDirs", () => {
  test("creates missing parent directories", () => {
    const root = tempRoot();
    try {
      const parent = join(root, "Sites");
      expect(existsSync(parent)).toBe(false);
      const created = ensureParentDirs([parent]);
      expect(created).toEqual([parent]);
      expect(existsSync(parent)).toBe(true);
      expect(ensureParentDirs([parent])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
