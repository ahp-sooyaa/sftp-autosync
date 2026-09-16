import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectWatcher } from "./watcher.js";

function createSyncConfig(root, remotePath, keyPath) {
  const meta = join(root, ".sftp-autosync");
  mkdirSync(meta, { recursive: true });
  writeFileSync(
    join(meta, "sync-config.json"),
    `${JSON.stringify(
      {
        host: "127.0.0.1",
        port: 2222,
        username: "deploy",
        privateKeyPath: keyPath,
        remotePath,
      },
      null,
      2,
    )}\n`,
  );
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
  /** @type {Array<{ op: string, projectName: string, remotePath: string }>} */
  calls = [];

  identityKey(project) {
    return `${project.username}@${project.host}:${project.port}:${project.privateKeyPath}`;
  }

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

describe("ProjectWatcher cross-project isolation", () => {
  /** @type {string | null} */
  let park = null;
  /** @type {ProjectWatcher | null} */
  let watcher = null;
  /** @type {MockPool | null} */
  let pool = null;

  afterEach(async () => {
    if (watcher) await watcher.stop();
    watcher = null;
    pool = null;
    if (park) rmSync(park, { recursive: true, force: true });
    park = null;
  });

  test("uploads and deletes in project A do not touch project B remotes", async () => {
    park = mkdtempSync(join(tmpdir(), "sftp-isolation-"));
    const keyPath = join(park, "id_test");
    writeFileSync(keyPath, "fake-key\n");

    const projectA = join(park, "project-a");
    const projectB = join(park, "project-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    createSyncConfig(projectA, "/remote/project-a", keyPath);
    createSyncConfig(projectB, "/remote/project-b", keyPath);
    writeFileSync(join(projectB, "sentinel.txt"), "keep\n");

    pool = new MockPool();
    watcher = new ProjectWatcher(globalConfig(park), pool);
    watcher.start();

    const targetFile = join(projectA, "only-a.txt");
    writeFileSync(targetFile, "project-a-only\n");
    await watcher.syncNow(projectA, targetFile);

    const uploadCalls = pool.calls.filter((call) => call.op === "upload");
    expect(uploadCalls.length).toBeGreaterThan(0);
    expect(uploadCalls.every((call) => call.projectName === "project-a")).toBe(true);
    expect(uploadCalls.every((call) => call.remotePath.startsWith("/remote/project-a"))).toBe(true);
    expect(pool.calls.some((call) => call.remotePath.startsWith("/remote/project-b"))).toBe(false);

    pool.calls.length = 0;
    unlinkSync(targetFile);
    await watcher.syncNow(projectA, targetFile);

    const deleteCalls = pool.calls.filter((call) => ["remove", "removeTree"].includes(call.op));
    expect(deleteCalls.length).toBeGreaterThan(0);
    expect(deleteCalls.every((call) => call.projectName === "project-a")).toBe(true);
    expect(deleteCalls.every((call) => call.remotePath.startsWith("/remote/project-a"))).toBe(true);
    expect(deleteCalls.some((call) => call.remotePath.startsWith("/remote/project-b"))).toBe(false);
    expect(existsSync(join(projectB, "sentinel.txt"))).toBe(true);
  });
});
