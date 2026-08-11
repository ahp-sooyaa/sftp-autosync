import { existsSync, readdirSync, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { discoverProjects } from "./config.js";
import { resolveRemotePath } from "./router.js";
import { META_DIR, ProjectVisibility } from "./visibility.js";

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
    this.#pathKinds.clear();
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
    this.#watchers.get(root)?.close();
    this.#watchers.delete(root);
    this.#projects.delete(root);

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
    const parts = relPosix.split("/");
    const base = parts[parts.length - 1] || "";

    // Never sync local meta/credentials.
    if (parts[0] === META_DIR || base === "sync-config.json") return true;

    for (const pattern of this.#global.ignore) {
      if (pattern.includes("*") || pattern.includes("?")) {
        if (matchGlob(base, pattern) || matchGlob(relPosix, pattern)) {
          return true;
        }
        continue;
      }
      if (parts.includes(pattern) || base === pattern) return true;
    }
    return false;
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
      await this.#visibility.track(current, { op: "upload", file: rel, remote }, () =>
        this.#pool.upload(current, absolutePath, remote),
      );
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

function matchGlob(text, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(text);
}
