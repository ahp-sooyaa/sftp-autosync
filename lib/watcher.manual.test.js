import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectWatcher } from "./watcher.js";

function createSyncConfig(root, remotePath, keyPath, mode = "auto") {
  const meta = join(root, ".sftp-autosync");
  mkdirSync(meta, { recursive: true });
  const config = {
    host: "127.0.0.1",
    port: 2222,
    username: "deploy",
    privateKeyPath: keyPath,
    remotePath,
  };
  if (mode) config.mode = mode;
  writeFileSync(join(meta, "sync-config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function globalConfig(park) {
  return {
    parents: [park],
    ignore: [".git", "node_modules", ".DS_Store", ".sftp-autosync", "*.tmp", "*.swp"],
    debounceMs: 50,
    rescanMs: 60_000,
    notify: { enabled: false, slowMs: 0, delayMs: 0, onSuccess: false, onFailure: false },
  };
}

class MockPool {
  calls = [];

  async upload(project, _localPath, remotePath) {
    this.calls.push({ op: "upload", projectName: project.name, remotePath });
  }

  async mkdir(project, remotePath) {
    this.calls.push({ op: "mkdir", projectName: project.name, remotePath });
  }

  async remove(project, remotePath) {
    this.calls.push({ op: "remove", projectName: project.name, remotePath });
  }

  async removeTree(project, remotePath) {
    this.calls.push({ op: "removeTree", projectName: project.name, remotePath });
  }

  async close() {}
}

describe("ProjectWatcher manual mode", () => {
  let park = null;
  let watcher = null;
  let pool = null;

  afterEach(async () => {
    if (watcher) await watcher.stop();
    watcher = null;
    pool = null;
    if (park) rmSync(park, { recursive: true, force: true });
    park = null;
  });

  test("watches auto projects only; manual projects never sync", async () => {
    park = mkdtempSync(join(tmpdir(), "sftp-manual-"));
    const keyPath = join(park, "id_test");
    writeFileSync(keyPath, "fake-key\n");

    const autoDir = join(park, "auto-app");
    const manualDir = join(park, "manual-app");
    mkdirSync(autoDir, { recursive: true });
    mkdirSync(manualDir, { recursive: true });
    createSyncConfig(autoDir, "/remote/auto", keyPath, "auto");
    createSyncConfig(manualDir, "/remote/manual", keyPath, "manual");

    pool = new MockPool();
    watcher = new ProjectWatcher(globalConfig(park), pool);
    watcher.start();

    const autoFile = join(autoDir, "sync-me.txt");
    const manualFile = join(manualDir, "ignore-me.txt");
    writeFileSync(autoFile, "auto\n");
    writeFileSync(manualFile, "manual\n");

    await watcher.syncNow(autoDir, autoFile);
    await expect(watcher.syncNow(manualDir, manualFile)).rejects.toThrow(/Unknown project/);

    expect(pool.calls.some((call) => call.projectName === "auto-app")).toBe(true);
    expect(pool.calls.some((call) => call.projectName === "manual-app")).toBe(false);
  });
});
