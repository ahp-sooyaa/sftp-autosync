import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CircuitBreakerRegistry, DEFAULT_FAILURE_THRESHOLD } from "./circuit-breaker.js";
import { loadPendingOps, pendingPath, savePendingOps } from "./pending.js";
import { ProjectWatcher, requestPendingDrain } from "./watcher.js";

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
        mode: "auto",
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

class RetryPool {
  /** @type {Array<{ op: string, projectName: string, remotePath: string }>} */
  calls = [];
  uploadAttempts = 0;
  failUploads = 1;

  identityKey(project) {
    return `${project.username}@${project.host}:${project.port}:${project.privateKeyPath}`;
  }

  async upload(project, _localPath, remotePath) {
    this.uploadAttempts += 1;
    if (this.uploadAttempts <= this.failUploads) {
      throw new Error("scp failed: exit 255");
    }
    this.calls.push({ op: "upload", projectName: project.name, remotePath });
  }

  async mkdir() {}
  async remove() {}
  async removeTree() {}
  async close() {}
}

function makeClock() {
  let now = 10_000;
  /** @type {Array<{ at: number, fn: () => void }>} */
  const timers = [];

  return {
    now: () => now,
    scheduleTimer: (fn, ms) => {
      timers.push({ at: now + ms, fn });
    },
    advanceTo(target) {
      timers.sort((a, b) => a.at - b.at);
      while (timers.length > 0 && timers[0].at <= target) {
        const next = timers.shift();
        now = next.at;
        next.fn();
      }
      now = Math.max(now, target);
    },
    pendingTimers: () => timers.length,
  };
}

describe("ProjectWatcher retry queue", () => {
  /** @type {string | null} */
  let park = null;
  /** @type {ProjectWatcher | null} */
  let watcher = null;
  /** @type {RetryPool | null} */
  let pool = null;

  afterEach(async () => {
    if (watcher) await watcher.stop();
    watcher = null;
    pool = null;
    if (park) rmSync(park, { recursive: true, force: true });
    park = null;
  });

  test("failed upload writes pending.json and retries after backoff", async () => {
    park = mkdtempSync(join(tmpdir(), "sftp-retry-"));
    const keyPath = join(park, "id_test");
    writeFileSync(keyPath, "fake-key\n");
    const projectRoot = join(park, "demo");
    mkdirSync(projectRoot, { recursive: true });
    createSyncConfig(projectRoot, "/remote/demo", keyPath);

    const clock = makeClock();
    pool = new RetryPool();
    watcher = new ProjectWatcher(globalConfig(park), pool, {
      now: clock.now,
      scheduleTimer: clock.scheduleTimer,
    });
    watcher.start();

    const target = join(projectRoot, "index.html");
    writeFileSync(target, "hello\n");

    await watcher.syncNow(projectRoot, target).catch(() => {});
    expect(pool.uploadAttempts).toBe(1);
    expect(existsSync(pendingPath(projectRoot))).toBe(true);
    const pending = loadPendingOps(projectRoot);
    expect(pending).toHaveLength(1);
    expect(pending[0].file).toBe("index.html");
    expect(pending[0].attempts).toBe(1);
    expect(pending[0].nextAt).toBe(11_000);

    clock.advanceTo(11_000);
    await watcher.stop();
    watcher = null;

    expect(pool.uploadAttempts).toBe(2);
    expect(pool.calls.some((call) => call.op === "upload")).toBe(true);
    expect(loadPendingOps(projectRoot)).toHaveLength(0);
  });

  test("daemon restart drains pending.json without another file change", async () => {
    park = mkdtempSync(join(tmpdir(), "sftp-retry-restart-"));
    const keyPath = join(park, "id_test");
    writeFileSync(keyPath, "fake-key\n");
    const projectRoot = join(park, "demo");
    mkdirSync(projectRoot, { recursive: true });
    createSyncConfig(projectRoot, "/remote/demo", keyPath);
    writeFileSync(join(projectRoot, "index.html"), "hello\n");

    const clock = makeClock();
    pool = new RetryPool();
    watcher = new ProjectWatcher(globalConfig(park), pool, {
      now: clock.now,
      scheduleTimer: clock.scheduleTimer,
    });
    watcher.start();

    await watcher.syncNow(projectRoot, join(projectRoot, "index.html")).catch(() => {});
    expect(pool.uploadAttempts).toBe(1);
    await watcher.stop();
    watcher = null;

    pool = new RetryPool();
    pool.failUploads = 0;
    watcher = new ProjectWatcher(globalConfig(park), pool, {
      now: clock.now,
      scheduleTimer: clock.scheduleTimer,
    });
    watcher.start();

    clock.advanceTo(11_000);
    await watcher.stop();
    watcher = null;

    expect(pool.uploadAttempts).toBe(1);
    expect(loadPendingOps(projectRoot)).toHaveLength(0);
  });

  test("open circuit blocks retries until probe time", async () => {
    park = mkdtempSync(join(tmpdir(), "sftp-retry-circuit-"));
    const keyPath = join(park, "id_test");
    writeFileSync(keyPath, "fake-key\n");
    const projectRoot = join(park, "demo");
    mkdirSync(projectRoot, { recursive: true });
    createSyncConfig(projectRoot, "/remote/demo", keyPath);
    writeFileSync(join(projectRoot, "index.html"), "hello\n");

    const clock = makeClock();
    const circuit = new CircuitBreakerRegistry();
    pool = new RetryPool();
    pool.failUploads = 99;

    watcher = new ProjectWatcher(globalConfig(park), pool, {
      now: clock.now,
      scheduleTimer: clock.scheduleTimer,
      circuit,
    });
    watcher.start();

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
      await watcher.syncNow(projectRoot, join(projectRoot, "index.html")).catch(() => {});
      clock.advanceTo(clock.now() + 1);
    }

    const attemptsBeforeProbe = pool.uploadAttempts;
    expect(
      circuit.isOpen(
        pool.identityKey({
          username: "deploy",
          host: "127.0.0.1",
          port: 2222,
          privateKeyPath: keyPath,
        }),
      ),
    ).toBe(true);

    clock.advanceTo(clock.now() + 500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pool.uploadAttempts).toBe(attemptsBeforeProbe);

    clock.advanceTo(clock.now() + 120_000);
    await watcher.stop();
    watcher = null;
    expect(pool.uploadAttempts).toBeGreaterThan(attemptsBeforeProbe);
  });

  test("does not start duplicate concurrent pending retries for the same path", async () => {
    park = mkdtempSync(join(tmpdir(), "sftp-retry-dup-"));
    const keyPath = join(park, "id_test");
    writeFileSync(keyPath, "fake-key\n");
    const projectRoot = join(park, "demo");
    mkdirSync(projectRoot, { recursive: true });
    createSyncConfig(projectRoot, "/remote/demo", keyPath);
    writeFileSync(join(projectRoot, "index.html"), "hello\n");

    const clock = makeClock();
    /** @type {(() => void) | null} */
    let releaseUpload = null;
    pool = {
      uploadAttempts: 0,
      identityKey(project) {
        return `${project.username}@${project.host}:${project.port}:${project.privateKeyPath}`;
      },
      async upload() {
        pool.uploadAttempts += 1;
        await new Promise((resolve) => {
          releaseUpload = resolve;
        });
      },
      async mkdir() {},
      async remove() {},
      async removeTree() {},
      async close() {},
    };

    watcher = new ProjectWatcher(globalConfig(park), pool, {
      now: clock.now,
      scheduleTimer: clock.scheduleTimer,
    });
    watcher.start();

    savePendingOps(projectRoot, [
      {
        file: "index.html",
        op: "upload",
        remote: "/remote/demo/index.html",
        attempts: 1,
        nextAt: clock.now(),
        lastError: "scp failed: exit 255",
      },
    ]);

    requestPendingDrain(projectRoot);
    requestPendingDrain(projectRoot);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pool.uploadAttempts).toBe(1);

    releaseUpload?.();
    await watcher.stop();
    watcher = null;
  });
});
