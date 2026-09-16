import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { metaDir, PENDING_FILE } from "./visibility.js";

/** Backoff delays after each failed attempt (1-based attempts index). */
export const BACKOFF_MS = [1000, 5000, 30_000, 120_000];

/**
 * @typedef {{ file: string, op: "upload" | "mkdir" | "delete", remote: string, attempts: number, nextAt: number, lastError: string }} PendingOp
 */

export function pendingPath(projectRoot) {
  return join(metaDir(projectRoot), PENDING_FILE);
}

/** Delay before the next retry for a given attempt count (1-based). */
export function backoffDelayMs(attempts) {
  const idx = Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx];
}

export function nextRetryAt(attempts, now = Date.now()) {
  return now + backoffDelayMs(attempts);
}

function isValidOp(op) {
  return (
    op &&
    typeof op.file === "string" &&
    (op.op === "upload" || op.op === "mkdir" || op.op === "delete") &&
    typeof op.remote === "string" &&
    typeof op.attempts === "number" &&
    typeof op.nextAt === "number"
  );
}

function quarantineCorruptPending(projectRoot) {
  const file = pendingPath(projectRoot);
  if (!existsSync(file)) return;
  const backup = `${file}.corrupt.${Date.now()}`;
  try {
    renameSync(file, backup);
  } catch {
    // ignore
  }
}

/** @returns {PendingOp[]} */
export function loadPendingOps(projectRoot) {
  const file = pendingPath(projectRoot);
  if (!existsSync(file)) return [];

  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(raw?.ops)) {
      quarantineCorruptPending(projectRoot);
      return [];
    }
    return raw.ops.filter(isValidOp);
  } catch {
    quarantineCorruptPending(projectRoot);
    return [];
  }
}

/** @param {PendingOp[]} ops */
export function savePendingOps(projectRoot, ops) {
  mkdirSync(metaDir(projectRoot), { recursive: true });
  const target = pendingPath(projectRoot);

  if (ops.length === 0) {
    if (existsSync(target)) {
      try {
        unlinkSync(target);
      } catch {
        // ignore
      }
    }
    return;
  }

  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify({ version: 1, ops }, null, 2)}\n`;
  writeFileSync(tmp, body);
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

export function removePendingOp(projectRoot, file) {
  const ops = loadPendingOps(projectRoot);
  const filtered = ops.filter((op) => op.file !== file);
  if (filtered.length === ops.length) return;
  savePendingOps(projectRoot, filtered);
}

/**
 * Queue or update a failed op. Newest op per path wins; increments attempts for backoff.
 * @returns {PendingOp}
 */
export function enqueueFailedOp(
  projectRoot,
  { file, op, remote, error },
  { now = Date.now() } = {},
) {
  const ops = loadPendingOps(projectRoot);
  const existing = ops.find((entry) => entry.file === file);
  const attempts = (existing?.attempts ?? 0) + 1;
  const entry = {
    file,
    op,
    remote,
    attempts,
    nextAt: nextRetryAt(attempts, now),
    lastError: error,
  };
  const filtered = ops.filter((item) => item.file !== file);
  filtered.push(entry);
  savePendingOps(projectRoot, filtered);
  return entry;
}

/**
 * Replace a pending op for a path (e.g. local change supersedes a queued retry).
 * Resets attempts when {@link resetAttempts} is true.
 */
export function upsertPendingOp(
  projectRoot,
  { file, op, remote, lastError = "", attempts = 0, nextAt },
  { now = Date.now(), resetAttempts = true } = {},
) {
  const ops = loadPendingOps(projectRoot).filter((entry) => entry.file !== file);
  const entry = {
    file,
    op,
    remote,
    attempts: resetAttempts ? 0 : attempts,
    nextAt: nextAt ?? now,
    lastError,
  };
  ops.push(entry);
  savePendingOps(projectRoot, ops);
  return entry;
}

export function summarizePending(projectRoot, { now = Date.now() } = {}) {
  const ops = loadPendingOps(projectRoot);
  if (ops.length === 0) {
    return { count: 0, nextAt: null, ops: [] };
  }
  const future = ops.map((op) => op.nextAt).filter((at) => at > now);
  const nextAt = future.length > 0 ? Math.min(...future) : null;
  const dueCount = ops.filter((op) => op.nextAt <= now).length;
  return { count: ops.length, dueCount, nextAt, ops };
}
