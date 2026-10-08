import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, makeFingerprint, saveContentHashes } from "./content-hashes.js";
import { ProjectWatcher } from "./watcher.js";

function createSyncConfig(root, remotePath, keyPath) {
  const meta = join(root, ".sftp-autosync");
  mkdirSync(meta, { recursive: true });
  writeFileSync(
    join(meta, "sync-config.json"),
    `${JSON.stringify({
      host: "127.0.0.1",
      port: 2222,
      username: "deploy",
      privateKeyPath: keyPath,
      remotePath,
      mode: "auto",
    }, null, 2)}\n`,
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
  calls = [];
  /** @type {Set<string>} remote paths that exist */
  remoteFiles = new Set();
  remotePathExistsCalls = 0;

  identityKey(project) {
    return `${project.username}@${project.host}:${project.port}:${project.privateKeyPath}`;
  }

  async remotePathExists(_project, remotePath) {
    this.remotePathExistsCalls += 1;
    return this.remoteFiles.has(remotePath);
  }

  async upload(project, _localPath, remotePath) {
    this.calls.push({ op: "upload", projectName: project.name, remotePath });
    this.remoteFiles.add(remotePath);
  }

  async mkdir(project, remotePath) {
    this.calls.push({ op: "mkdir", projectName: project.name, remotePath });
  }

  async remove() {}

  async close() {}
}

describe("ProjectWatcher unowned remote", () => {
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

  test("skip upload when remote exists and no fingerprint", async () => {
    park = mkdtempSync(join(tmpdir(), "sftp-unowned-"));
    const keyPath = join(park, "id_test");
    writeFileSync(keyPath, "fake-key\n");

    const appDir = join(park, "demo");
    mkdirSync(appDir, { recursive: true });
    createSyncConfig(appDir, "/remote/demo", keyPath);

    const target = join(appDir, "index.html");
    writeFileSync(target, "hello\n");
    const remote = "/remote/demo/index.html";

    pool = new MockPool();
    pool.remoteFiles.add(remote);

    watcher = new ProjectWatcher(globalConfig(park), pool);
    watcher.start();

    await watcher.syncNow(appDir, target);

    expect(pool.calls.filter((c) => c.op === "upload")).toHaveLength(0);
    expect(pool.remotePathExistsCalls).toBeGreaterThan(0);
  });

  test("upload when remote missing and no fingerprint", async () => {
    park = mkdtempSync(join(tmpdir(), "sftp-unowned-new-"));
    const keyPath = join(park, "id_test");
    writeFileSync(keyPath, "fake-key\n");

    const appDir = join(park, "demo");
    mkdirSync(appDir, { recursive: true });
    createSyncConfig(appDir, "/remote/demo", keyPath);

    const target = join(appDir, "new.html");
    writeFileSync(target, "new\n");

    pool = new MockPool();
    watcher = new ProjectWatcher(globalConfig(park), pool);
    watcher.start();

    await watcher.syncNow(appDir, target);

    expect(pool.calls.filter((c) => c.op === "upload")).toHaveLength(1);
    expect(pool.remotePathExistsCalls).toBeGreaterThan(0);
  });

  test("upload with fingerprint does not probe remote", async () => {
    park = mkdtempSync(join(tmpdir(), "sftp-owned-"));
    const keyPath = join(park, "id_test");
    writeFileSync(keyPath, "fake-key\n");

    const appDir = join(park, "demo");
    mkdirSync(appDir, { recursive: true });
    createSyncConfig(appDir, "/remote/demo", keyPath);

    const target = join(appDir, "owned.html");
    writeFileSync(target, "v1\n");
    const stV1 = statSync(target);
    const hashV1 = contentHash(readFileSync(target));
    saveContentHashes(appDir, new Map([[target, makeFingerprint(hashV1, stV1)]]));

    writeFileSync(target, "v2-changed\n");

    pool = new MockPool();
    pool.remoteFiles.add("/remote/demo/owned.html");

    watcher = new ProjectWatcher(globalConfig(park), pool);
    watcher.start();

    await watcher.syncNow(appDir, target);

    expect(pool.calls.filter((c) => c.op === "upload")).toHaveLength(1);
    expect(pool.remotePathExistsCalls).toBe(0);
  });

  test("retries after bytes change during scp even when remote now exists", async () => {
    park = mkdtempSync(join(tmpdir(), "sftp-resync-"));
    const keyPath = join(park, "id_test");
    writeFileSync(keyPath, "fake-key\n");

    const appDir = join(park, "demo");
    mkdirSync(appDir, { recursive: true });
    createSyncConfig(appDir, "/remote/demo", keyPath);

    const target = join(appDir, "race.html");
    writeFileSync(target, "v1\n");

    pool = new MockPool();
    pool.upload = async (project, localPath, remotePath) => {
      pool.calls.push({ op: "upload", projectName: project.name, remotePath });
      pool.remoteFiles.add(remotePath);
      writeFileSync(localPath, "v2-after-scp\n");
    };

    watcher = new ProjectWatcher(globalConfig(park), pool);
    watcher.start();

    await watcher.syncNow(appDir, target);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(pool.calls.filter((c) => c.op === "upload").length).toBeGreaterThanOrEqual(2);
  });
});
