import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { metaDir } from "./visibility.js";

export const HASHES_FILE = "content-hashes.json";
/** Locks older than this (or with a dead pid) may be broken. */
export const HASH_LOCK_STALE_MS = 30_000;

export function hashesPath(projectRoot) {
  return join(metaDir(projectRoot), HASHES_FILE);
}

export function hashesLockPath(projectRoot) {
  return `${hashesPath(projectRoot)}.lock`;
}

/** SHA-256 hex digest of file bytes. */
export function contentHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sleepMs(ms) {
  if (typeof Bun !== "undefined" && typeof Bun.sleepSync === "function") {
    Bun.sleepSync(ms);
    return;
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait when Bun.sleepSync is unavailable
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Remove a lock left behind by a crashed holder (dead pid, or aged lock with no live owner).
 * Never steals a lock whose recorded pid is still alive.
 * @returns {boolean} true when the lock file was removed
 */
export function breakStaleContentHashLock(
  projectRoot,
  { now = Date.now(), staleMs = HASH_LOCK_STALE_MS } = {},
) {
  const lockPath = hashesLockPath(projectRoot);
  if (!existsSync(lockPath)) return false;

  let ageMs = 0;
  try {
    ageMs = now - statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }

  let pid = null;
  try {
    const parsed = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    pid = null;
  }

  if (pid != null && isPidAlive(pid)) return false;
  if (pid != null && !isPidAlive(pid)) {
    try {
      unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  // No usable pid (crash before write) — only break once aged out.
  if (ageMs < staleMs) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serialize hash-file readers/writers across watcher + push/seed processes.
 * @template T
 * @param {string} projectRoot
 * @param {() => T} fn
 * @returns {T}
 */
export function withContentHashLock(projectRoot, fn) {
  mkdirSync(metaDir(projectRoot), { recursive: true });
  const lockPath = hashesLockPath(projectRoot);
  const deadline = Date.now() + 5_000;
  let attemptedStaleBreak = false;

  const acquire = () => {
    const fd = openSync(lockPath, "wx");
    try {
      writeSync(fd, `${process.pid}\n`);
      return fn();
    } finally {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
  };

  while (Date.now() < deadline) {
    try {
      return acquire();
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (!attemptedStaleBreak) {
        attemptedStaleBreak = true;
        if (breakStaleContentHashLock(projectRoot)) continue;
      }
      sleepMs(20);
    }
  }

  breakStaleContentHashLock(projectRoot);
  try {
    return acquire();
  } catch (err) {
    if (err?.code === "EEXIST") {
      throw new Error(`Timed out waiting for content-hash lock: ${lockPath}`);
    }
    throw err;
  }
}

/**
 * @returns {{ status: "missing" | "ok" | "corrupt", map: Map<string, string> }}
 */
export function readContentHashStore(projectRoot) {
  const file = hashesPath(projectRoot);
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!existsSync(file)) return { status: "missing", map };

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { status: "corrupt", map };
  }

  if (!text.trim()) return { status: "corrupt", map };

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: "corrupt", map };
  }

  const files = raw?.files && typeof raw.files === "object" ? raw.files : null;
  if (!files) return { status: "corrupt", map };

  for (const [rel, hash] of Object.entries(files)) {
    if (typeof rel !== "string" || typeof hash !== "string" || !rel || !hash) continue;
    if (rel.includes("\0") || rel.startsWith("/") || rel.includes("..")) continue;
    map.set(join(projectRoot, ...rel.split("/")), hash);
  }
  return { status: "ok", map };
}

/**
 * Load persisted upload fingerprints.
 * Corrupt files are quarantined (renamed) so merges never treat them as empty.
 * @returns {Map<string, string>} absolute path → SHA-256
 */
export function loadContentHashes(projectRoot) {
  const loaded = readContentHashStore(projectRoot);
  if (loaded.status === "corrupt") {
    quarantineCorruptHashStore(projectRoot);
    return new Map();
  }
  return loaded.map;
}

function quarantineCorruptHashStore(projectRoot) {
  const file = hashesPath(projectRoot);
  if (!existsSync(file)) return;
  const backup = `${file}.corrupt.${Date.now()}`;
  try {
    renameSync(file, backup);
  } catch {
    // ignore — merge will still refuse empty overwrite via atomic write of recovered state
  }
}

/**
 * Persist fingerprints via temp file + rename (crash-safe).
 * Prefer {@link mergeContentHashUpdates} when the watcher and push may race.
 * @param {string} projectRoot
 * @param {Map<string, string>} absoluteToHash
 */
export function saveContentHashes(projectRoot, absoluteToHash) {
  mkdirSync(metaDir(projectRoot), { recursive: true });
  /** @type {Record<string, string>} */
  const files = {};
  for (const [absolute, hash] of absoluteToHash) {
    const rel = relative(projectRoot, absolute).split(sep).join("/");
    if (!rel || rel.startsWith("..")) continue;
    files[rel] = hash;
  }
  const target = hashesPath(projectRoot);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
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

/**
 * Atomically load → apply upserts/removes → save so concurrent push/seed
 * fingerprints are not wiped by a partial watcher flush.
 *
 * @param {string} projectRoot
 * @param {{ upserts?: Map<string, string> | Iterable<[string, string]>, removes?: Iterable<string> }} [updates]
 * @returns {Map<string, string>} absolute path → hash after merge
 */
export function mergeContentHashUpdates(projectRoot, { upserts = [], removes = [] } = {}) {
  return withContentHashLock(projectRoot, () => {
    const loaded = readContentHashStore(projectRoot);
    let map = loaded.map;
    if (loaded.status === "corrupt") {
      quarantineCorruptHashStore(projectRoot);
      map = new Map();
    }
    for (const absolute of removes) {
      map.delete(absolute);
      // Also drop descendants when a directory tree was removed.
      const prefix = absolute.endsWith(sep) ? absolute : absolute + sep;
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    }
    for (const [absolute, hash] of upserts) {
      if (typeof hash === "string" && hash) map.set(absolute, hash);
    }
    saveContentHashes(projectRoot, map);
    return map;
  });
}

/**
 * Hash every non-ignored file on disk and persist (trust remote already matches).
 * Walk + write happen under the lock so concurrent push/watcher updates cannot
 * be clobbered by a stale pre-lock snapshot.
 * @param {string} projectRoot
 * @param {(relPosix: string) => boolean} shouldIgnore
 * @returns {{ count: number, path: string }}
 */
export function seedContentHashesFromDisk(projectRoot, shouldIgnore) {
  return withContentHashLock(projectRoot, () => {
    /** @type {Map<string, string>} */
    const map = new Map();
    walkFiles(projectRoot, shouldIgnore, (absolute) => {
      try {
        map.set(absolute, contentHash(readFileSync(absolute)));
      } catch {
        // unreadable — skip
      }
    });
    saveContentHashes(projectRoot, map);
    return { count: map.size, path: hashesPath(projectRoot) };
  });
}

/**
 * Collect absolute paths of non-ignored files (and optionally dirs).
 * @param {string} projectRoot
 * @param {(relPosix: string) => boolean} shouldIgnore
 * @param {"file" | "all"} [kinds]
 * @returns {string[]}
 */
export function listProjectPaths(projectRoot, shouldIgnore, kinds = "file") {
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const absolute = join(dir, ent.name);
      const rel = relative(projectRoot, absolute).split(sep).join("/");
      if (shouldIgnore(rel)) continue;
      if (ent.isDirectory()) {
        if (kinds === "all") out.push(absolute);
        walk(absolute);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        out.push(absolute);
      }
    }
  };
  walk(projectRoot);
  return out;
}

function walkFiles(projectRoot, shouldIgnore, visit) {
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const absolute = join(dir, ent.name);
      const rel = relative(projectRoot, absolute).split(sep).join("/");
      if (shouldIgnore(rel)) continue;
      if (ent.isDirectory()) {
        walk(absolute);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        visit(absolute, rel);
      }
    }
  };
  walk(projectRoot);
}

/** True when we already successfully uploaded / seeded these exact bytes. */
export function shouldSkipUnchanged(previousHash, nextHash) {
  return previousHash != null && previousHash === nextHash;
}

/**
 * After scp, confirm on-disk bytes still match the pre-upload hash before
 * recording a skip fingerprint (scp re-reads the path independently).
 */
export function uploadedBytesStillMatch(preUploadHash, postUploadHash) {
  return postUploadHash != null && postUploadHash === preUploadHash;
}
