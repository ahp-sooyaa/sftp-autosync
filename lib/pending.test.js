import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backoffDelayMs,
  enqueueFailedOp,
  loadPendingOps,
  nextRetryAt,
  pendingPath,
  removePendingOp,
  savePendingOps,
  summarizePending,
  upsertPendingOp,
} from "./pending.js";

describe("pending backoff", () => {
  test("uses 1s → 5s → 30s → 2m then stays at 2m", () => {
    expect(backoffDelayMs(1)).toBe(1000);
    expect(backoffDelayMs(2)).toBe(5000);
    expect(backoffDelayMs(3)).toBe(30_000);
    expect(backoffDelayMs(4)).toBe(120_000);
    expect(backoffDelayMs(99)).toBe(120_000);
  });

  test("nextRetryAt adds backoff to now", () => {
    expect(nextRetryAt(1, 1000)).toBe(2000);
    expect(nextRetryAt(2, 1000)).toBe(6000);
  });
});

describe("pending store", () => {
  /** @type {string | null} */
  let root = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function makeProject() {
    root = mkdtempSync(join(tmpdir(), "sftp-pending-"));
    mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
    return root;
  }

  test("persist and load round-trip", () => {
    const projectRoot = makeProject();
    savePendingOps(projectRoot, [
      {
        file: "index.html",
        op: "upload",
        remote: "/var/www/index.html",
        attempts: 1,
        nextAt: 2000,
        lastError: "scp failed",
      },
    ]);

    const ops = loadPendingOps(projectRoot);
    expect(ops).toHaveLength(1);
    expect(ops[0].file).toBe("index.html");
    expect(existsSync(pendingPath(projectRoot))).toBe(true);
  });

  test("newest op per path wins via enqueueFailedOp", () => {
    const projectRoot = makeProject();
    enqueueFailedOp(
      projectRoot,
      { file: "a.txt", op: "upload", remote: "/r/a.txt", error: "first" },
      { now: 1000 },
    );
    enqueueFailedOp(
      projectRoot,
      { file: "a.txt", op: "upload", remote: "/r/a.txt", error: "second" },
      { now: 2000 },
    );

    const ops = loadPendingOps(projectRoot);
    expect(ops).toHaveLength(1);
    expect(ops[0].attempts).toBe(2);
    expect(ops[0].lastError).toBe("second");
    expect(ops[0].nextAt).toBe(nextRetryAt(2, 2000));
  });

  test("removePendingOp clears a path and deletes file when empty", () => {
    const projectRoot = makeProject();
    enqueueFailedOp(
      projectRoot,
      { file: "a.txt", op: "upload", remote: "/r/a.txt", error: "err" },
      { now: 0 },
    );
    removePendingOp(projectRoot, "a.txt");
    expect(loadPendingOps(projectRoot)).toHaveLength(0);
    expect(existsSync(pendingPath(projectRoot))).toBe(false);
  });

  test("upsertPendingOp replaces an existing path", () => {
    const projectRoot = makeProject();
    upsertPendingOp(
      projectRoot,
      { file: "b.txt", op: "mkdir", remote: "/r/b", lastError: "x", attempts: 2, nextAt: 50 },
      { now: 0 },
    );
    const ops = loadPendingOps(projectRoot);
    expect(ops[0].op).toBe("mkdir");
    expect(ops[0].attempts).toBe(0);
  });

  test("corrupt pending.json is quarantined and treated as empty", () => {
    const projectRoot = makeProject();
    writeFileSync(pendingPath(projectRoot), "{not json");
    expect(loadPendingOps(projectRoot)).toEqual([]);
    expect(existsSync(pendingPath(projectRoot))).toBe(false);
    const names = readdirSync(join(projectRoot, ".sftp-autosync"));
    expect(names.some((n) => n.startsWith("pending.json.corrupt."))).toBe(true);
  });

  test("summarizePending reports count and next retry", () => {
    const projectRoot = makeProject();
    savePendingOps(projectRoot, [
      {
        file: "a.txt",
        op: "upload",
        remote: "/r/a",
        attempts: 1,
        nextAt: 500,
        lastError: "e",
      },
      {
        file: "b.txt",
        op: "upload",
        remote: "/r/b",
        attempts: 1,
        nextAt: 1500,
        lastError: "e",
      },
    ]);
    const summary = summarizePending(projectRoot, { now: 1000 });
    expect(summary.count).toBe(2);
    expect(summary.dueCount).toBe(1);
    expect(summary.nextAt).toBe(1500);
  });
});
