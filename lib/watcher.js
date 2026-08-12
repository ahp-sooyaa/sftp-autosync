import { existsSync, readdirSync, watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import {
  contentHash,
  loadContentHashes,
  mergeContentHashUpdates,
  shouldSkipUnchanged,
  uploadedBytesStillMatch,
} from "./content-hashes.js";
import { discoverProjects } from "./config.js";
import { shouldIgnoreRel } from "./ignore.js";
import { resolveRemotePath } from "./router.js";
import { ProjectVisibility } from "./visibility.js";

/**
 * Watch parked projects with Bun/Node fs.watch (recursive FSEvents on macOS).
 */
export class ProjectWatcher {
  #global;
  #pool;
  #visibility;
  #projects = new Map();
  #watchers = new Map();
  #parentWatchers = new Map();
  /** @type {Map<string, { project: object, timer: ReturnType<typeof setTimeout> }>} */
  #pending = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  #opaqueResync = new Map();
  /** @type {Map<string, "file" | "dir">} remembered kinds for delete routing */
  #pathKinds = new Map();
  /** @type {Map<string, string>} absolute path → content hash after last successful upload */
  #contentHashes = new Map();
  /** @type {Map<string, Map<string, string>>} projectRoot → pending hash upserts */
  #dirtyUpserts = new Map();
  /** @type {Map<string, Set<string>>} projectRoot → pending hash removals */
  #dirtyRemoves = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} debounced disk writes per project */
  #persistTimers = new Map();
  /** @type {Set<Promise<void>>} */
  #inflight = new Set();
  #rescanTimer = null;
  #stopping = false;

  constructor(globalConfig, pool) {
    this.#global = globalConfig;
    this.#pool = pool;
    this.#visibility = new ProjectVisibility({
      notify: globalConfig.notify.enabled,
      slowMs: globalConfig.notify.slowMs,
      delayMs: globalConfig.notify.delayMs,
      onSuccess: globalConfig.notify.onSuccess,
      onFailure: globalConfig.notify.onFailure,
    });
  }

  start() {
    this.#stopping = false;
    this.#syncProjects();
    this.#rescanTimer = setInterval(() => this.#syncProjects(), this.#global.rescanMs);
    if (typeof this.#rescanTimer.unref === "function") {
      this.#rescanTimer.unref();
    }
  }

  /**
   * Stop watching, flush debounced work, and wait for in-flight sync ops.
   */
  async stop() {
    this.#stopping = true;
    if (this.#rescanTimer) clearInterval(this.#rescanTimer);
    this.#rescanTimer = null;

    for (const w of this.#watchers.values()) w.close();
    this.#watchers.clear();
    for (const w of this.#parentWatchers.values()) w.close();
    this.#parentWatchers.clear();

    for (const timer of this.#opaqueResync.values()) clearTimeout(timer);
    this.#opaqueResync.clear();

    // Flush pending debounce timers as immediate handles so shutdown does not drop work.
    const pending = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [absolutePath, { project, timer }] of pending) {
      clearTimeout(timer);
      this.#trackInflight(this.#handle(project, absolutePath));
    }

    await Promise.allSettled([...this.#inflight]);
    this.#flushAllPersists({ final: true });
    if (this.#dirtyUpserts.size > 0 || this.#dirtyRemoves.size > 0) {
      // One more pass for roots that re-queued during the first final flush.
      this.#flushAllPersists({ final: true });
    }
    if (this.#dirtyUpserts.size > 0 || this.#dirtyRemoves.size > 0) {
      console.warn("[watch] some content hashes could not be persisted before shutdown");
    }
    this.#pathKinds.clear();
    this.#contentHashes.clear();
    this.#dirtyUpserts.clear();
    this.#dirtyRemoves.clear();
  }

  #syncProjects() {
    if (this.#stopping) return;

    // Retry parent watches each sync so late-appearing or previously failed
    // parents are picked up without waiting forever on a one-shot start().
    for (const parent of this.#global.parents) {
      this.#watchParent(parent);
    }

    const next = discoverProjects(this.#global.parents);
    const nextRoots = new Set(next.keys());

    for (const root of this.#projects.keys()) {
      if (!nextRoots.has(root)) {
        console.log(`[watch] remove project ${basename(root)}`);
        this.#dropProject(root);
      }
    }

    for (const [root, project] of next) {
      const prev = this.#projects.get(root);
      this.#projects.set(root, project);
      this.#visibility.ensure(project.root);
      if (!this.#watchers.has(root)) {
        console.log(
          `[watch] add project ${project.name} -> ${project.username}@${project.host}:${project.port}`,
        );
        this.#watchProject(project);
      } else if (prev && JSON.stringify(prev) !== JSON.stringify(project)) {
        console.log(`[watch] reload config ${project.name}`);
      }
    }
  }

  /** Tear down watchers, timers, and indexes for an unregistered project. */
  #dropProject(root) {
    this.#flushPersist(root, { final: true });
    this.#watchers.get(root)?.close();
    this.#watchers.delete(root);
    this.#projects.delete(root);
    // Dirty maps are cleared only after a successful flushPersist; a failed
    // final flush leaves them for stop()'s last flushAllPersists({ final: true }).

    const opaque = this.#opaqueResync.get(root);
    if (opaque) {
      clearTimeout(opaque);
      this.#opaqueResync.delete(root);
    }

    for (const path of pathsUnderRoot(this.#pending.keys(), root)) {
      const entry = this.#pending.get(path);
      if (entry) clearTimeout(entry.timer);
      this.#pending.delete(path);
    }

    for (const path of pathsUnderRoot(this.#pathKinds.keys(), root)) {
      this.#pathKinds.delete(path);
    }
    for (const path of pathsUnderRoot(this.#contentHashes.keys(), root)) {
      this.#contentHashes.delete(path);
    }
  }

  #watchParent(parent) {
    if (!existsSync(parent) || this.#parentWatchers.has(parent)) return;
    try {
      const w = watch(parent, () => this.#syncProjects());
      this.#parentWatchers.set(parent, w);
      console.log(`[watch] parked parent ${parent}`);
    } catch (err) {
      console.warn(`[watch] cannot watch parent ${parent}: ${err.message}`);
    }
  }

  #watchProject(project) {
    try {
      for (const [absolute, kind] of collectPathKinds(project.root, (rel) =>
        this.#shouldIgnore(rel),
      )) {
        this.#pathKinds.set(absolute, kind);
      }
      this.#reloadContentHashes(project.root);
      const w = watch(project.root, { recursive: true }, (_event, filename) => {
        if (this.#stopping) return;
        // Node does not always provide filename (batched FSEvents). Resync the tree.
        if (!filename) {
          this.#scheduleOpaqueResync(project);
          return;
        }
        const rel = filename.split(sep).join("/");
        if (this.#shouldIgnore(rel)) return;
        const absolute = join(project.root, filename);
        this.#schedule(project, absolute);
      });
      this.#watchers.set(project.root, w);
    } catch (err) {
      console.warn(`[watch] cannot watch ${project.root}: ${err.message}`);
    }
  }

  /** Replace in-memory fingerprints for a project from the on-disk store. */
  #reloadContentHashes(projectRoot) {
    for (const path of pathsUnderRoot(this.#contentHashes.keys(), projectRoot)) {
      this.#contentHashes.delete(path);
    }
    for (const [absolute, hash] of loadContentHashes(projectRoot)) {
      this.#contentHashes.set(absolute, hash);
    }
  }

  /**
   * When filename is missing, compare remembered paths to the live tree and
   * schedule create/update/delete for every difference.
   */
  #scheduleOpaqueResync(project) {
    const existing = this.#opaqueResync.get(project.root);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.#opaqueResync.delete(project.root);
      if (this.#stopping) return;
      this.#runOpaqueResync(project);
    }, this.#global.debounceMs);

    this.#opaqueResync.set(project.root, timer);
  }

  #runOpaqueResync(project) {
    const current = this.#projects.get(project.root);
    if (!current) return;
    const live = collectPathKinds(current.root, (rel) => this.#shouldIgnore(rel));
    const remembered = pathsUnderRoot(this.#pathKinds.keys(), current.root);

    for (const absolute of opaqueResyncPaths(live.keys(), remembered)) {
      this.#schedule(current, absolute);
    }
  }

  #shouldIgnore(relPosix) {
    return shouldIgnoreRel(relPosix, this.#global.ignore);
  }

  #schedule(project, absolutePath) {
    if (this.#stopping) return;

    const key = absolutePath;
    const existing = this.#pending.get(key);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.#pending.delete(key);
      this.#trackInflight(this.#handle(project, absolutePath));
    }, this.#global.debounceMs);

    this.#pending.set(key, { project, timer });
  }

  #trackInflight(promise) {
    const tracked = Promise.resolve(promise).catch((err) => {
      // Already logged + notified inside visibility.track when used;
      // cover paths that throw before track.
      console.error(`[sync] ${err.message}`);
    });
    this.#inflight.add(tracked);
    tracked.finally(() => this.#inflight.delete(tracked));
    return tracked;
  }

  #queueHashUpsert(projectRoot, absolutePath, hash) {
    this.#contentHashes.set(absolutePath, hash);
    let upserts = this.#dirtyUpserts.get(projectRoot);
    if (!upserts) {
      upserts = new Map();
      this.#dirtyUpserts.set(projectRoot, upserts);
    }
    upserts.set(absolutePath, hash);
    this.#dirtyRemoves.get(projectRoot)?.delete(absolutePath);
    this.#schedulePersist(projectRoot);
  }

  #queueHashRemove(projectRoot, absolutePath) {
    this.#contentHashes.delete(absolutePath);
    this.#dirtyUpserts.get(projectRoot)?.delete(absolutePath);
    let removes = this.#dirtyRemoves.get(projectRoot);
    if (!removes) {
      removes = new Set();
      this.#dirtyRemoves.set(projectRoot, removes);
    }
    removes.add(absolutePath);
    this.#schedulePersist(projectRoot);
  }

  #schedulePersist(projectRoot) {
    const existing = this.#persistTimers.get(projectRoot);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#persistTimers.delete(projectRoot);
      this.#flushPersist(projectRoot);
    }, 250);
    this.#persistTimers.set(projectRoot, timer);
  }

  #flushPersist(projectRoot, { final = false } = {}) {
    const timer = this.#persistTimers.get(projectRoot);
    if (timer) {
      clearTimeout(timer);
      this.#persistTimers.delete(projectRoot);
    }

    const upserts = this.#dirtyUpserts.get(projectRoot) ?? new Map();
    const removes = this.#dirtyRemoves.get(projectRoot) ?? new Set();
    this.#dirtyUpserts.delete(projectRoot);
    this.#dirtyRemoves.delete(projectRoot);

    if (upserts.size === 0 && removes.size === 0) {
      // Still refresh memory so push/seed written while idle is visible.
      this.#reloadContentHashes(projectRoot);
      return true;
    }

    const applyMerged = (merged) => {
      for (const path of pathsUnderRoot(this.#contentHashes.keys(), projectRoot)) {
        this.#contentHashes.delete(path);
      }
      for (const [absolute, hash] of merged) {
        this.#contentHashes.set(absolute, hash);
      }
    };

    const requeue = () => {
      let retryUpserts = this.#dirtyUpserts.get(projectRoot);
      if (!retryUpserts) {
        retryUpserts = new Map();
        this.#dirtyUpserts.set(projectRoot, retryUpserts);
      }
      for (const [absolute, hash] of upserts) {
        this.#contentHashes.set(absolute, hash);
        retryUpserts.set(absolute, hash);
      }
      let retryRemoves = this.#dirtyRemoves.get(projectRoot);
      if (!retryRemoves) {
        retryRemoves = new Set();
        this.#dirtyRemoves.set(projectRoot, retryRemoves);
      }
      for (const absolute of removes) {
        this.#contentHashes.delete(absolute);
        retryUpserts.delete(absolute);
        retryRemoves.add(absolute);
      }
    };

    try {
      applyMerged(mergeContentHashUpdates(projectRoot, { upserts, removes }));
      return true;
    } catch (err) {
      if (!final) {
        console.warn(`[watch] cannot save hashes for ${basename(projectRoot)}: ${err.message}`);
        requeue();
        this.#schedulePersist(projectRoot);
        return false;
      }

      // Shutdown / project drop: retry synchronously so we do not discard
      // fingerprints behind a deferred timer that will never run.
      let lastErr = err;
      for (let i = 0; i < 8; i++) {
        const waitMs = 50 * (i + 1);
        if (typeof Bun !== "undefined" && typeof Bun.sleepSync === "function") {
          Bun.sleepSync(waitMs);
        }
        try {
          applyMerged(mergeContentHashUpdates(projectRoot, { upserts, removes }));
          return true;
        } catch (retryErr) {
          lastErr = retryErr;
        }
      }
      console.warn(
        `[watch] failed to persist hashes for ${basename(projectRoot)} during shutdown: ${lastErr.message}`,
      );
      requeue();
      return false;
    }
  }

  #flushAllPersists({ final = false } = {}) {
    for (const root of new Set([
      ...this.#persistTimers.keys(),
      ...this.#dirtyUpserts.keys(),
      ...this.#dirtyRemoves.keys(),
      ...this.#projects.keys(),
    ])) {
      this.#flushPersist(root, { final });
    }
  }

  /** Prefer memory, then disk (covers push/seed while the daemon was already running). */
  #fingerprintFor(projectRoot, absolutePath) {
    const cached = this.#contentHashes.get(absolutePath);
    if (cached != null) return cached;
    const fromDisk = loadContentHashes(projectRoot).get(absolutePath);
    if (fromDisk != null) this.#contentHashes.set(absolutePath, fromDisk);
    return fromDisk;
  }

  async #handle(project, absolutePath) {
    // Do not fall back to a stale closure after the project was unregistered.
    const current = this.#projects.get(project.root);
    if (!current) return;

    const rel = relative(current.root, absolutePath).split(sep).join("/");
    if (!rel || rel.startsWith("..")) return;
    if (this.#shouldIgnore(rel)) return;

    let st = null;
    try {
      st = await stat(absolutePath);
    } catch {
      st = null;
    }

    const remote = resolveRemotePath(current, absolutePath);

    if (!st) {
      const kind = this.#pathKinds.get(absolutePath);
      const prefix = absolutePath + sep;
      const hadDescendants = [...this.#pathKinds.keys()].some((path) => path.startsWith(prefix));

      // Drop self + descendants from the index before remote delete.
      for (const path of [...this.#pathKinds.keys()]) {
        if (path === absolutePath || path.startsWith(prefix)) {
          this.#pathKinds.delete(path);
        }
      }
      for (const path of [...this.#contentHashes.keys()]) {
        if (path === absolutePath || path.startsWith(prefix)) {
          this.#queueHashRemove(current.root, path);
        }
      }

      // Directory (or tree with remembered children) → recursive remote remove.
      const removeDirTree = shouldRemoveRemoteTree(kind, hadDescendants);
      await this.#visibility.track(current, { op: "delete", file: rel, remote }, () =>
        removeDirTree
          ? this.#pool.removeTree(current, remote)
          : this.#pool.remove(current, remote, kind),
      );
      return;
    }

    if (st.isDirectory()) {
      this.#pathKinds.set(absolutePath, "dir");
      await this.#visibility.track(current, { op: "mkdir", file: rel, remote }, () =>
        this.#pool.mkdir(current, remote),
      );
      return;
    }

    if (st.isFile()) {
      this.#pathKinds.set(absolutePath, "file");
      const bytes = await readFile(absolutePath);
      const hash = contentHash(bytes);
      if (shouldSkipUnchanged(this.#fingerprintFor(current.root, absolutePath), hash)) {
        console.log(`[${current.name}] skip unchanged ${rel}`);
        return;
      }
      await this.#visibility.track(current, { op: "upload", file: rel, remote }, () =>
        this.#pool.upload(current, absolutePath, remote),
      );
      // scp re-reads the path; only fingerprint when on-disk bytes still match
      // what we hashed, otherwise reschedule so the newer content is uploaded.
      let afterHash = null;
      try {
        afterHash = contentHash(await readFile(absolutePath));
      } catch {
        afterHash = null;
      }
      if (uploadedBytesStillMatch(hash, afterHash)) {
        this.#queueHashUpsert(current.root, absolutePath, hash);
      } else if (!this.#stopping && this.#projects.has(current.root)) {
        this.#queueHashRemove(current.root, absolutePath);
        this.#schedule(current, absolutePath);
      }
    }
  }
}

/**
 * Index existing files/dirs under a project root so deletes before any
 * mkdir/upload still know whether to call rmdir vs rm.
 * @param {string} projectRoot
 * @param {(relPosix: string) => boolean} shouldIgnore
 * @returns {Map<string, "file" | "dir">}
 */
export function collectPathKinds(projectRoot, shouldIgnore) {
  /** @type {Map<string, "file" | "dir">} */
  const pathKinds = new Map();

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
        pathKinds.set(absolute, "dir");
        walk(absolute);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        pathKinds.set(absolute, "file");
      }
    }
  };

  walk(projectRoot);
  return pathKinds;
}

/** Paths at or under a project root (absolute path keys). */
export function pathsUnderRoot(paths, root) {
  const prefix = root + sep;
  return [...paths].filter((path) => path === root || path.startsWith(prefix));
}

/** Whether a local delete should recursively wipe the remote tree. */
export function shouldRemoveRemoteTree(kind, hadDescendants) {
  return kind === "dir" || Boolean(hadDescendants);
}

/** Union of live and remembered paths to schedule after an opaque fs.watch event. */
export function opaqueResyncPaths(liveKeys, rememberedKeys) {
  return [...new Set([...liveKeys, ...rememberedKeys])];
}

export { contentHash, shouldSkipUnchanged, uploadedBytesStillMatch };
