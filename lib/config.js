import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { CONFIG_FILE, META_DIR, configPath } from "./visibility.js";

const DEFAULT_IGNORE = [".git", "node_modules", ".DS_Store", META_DIR, "*.tmp", "*.swp"];

/** Expand ~/ and resolve to an absolute path. */
export function expandHome(path) {
  if (!path) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

export function loadGlobalConfig(configPathArg) {
  const absolute = expandHome(configPathArg);
  if (!existsSync(absolute)) {
    throw new Error(`Global config not found: ${absolute}`);
  }

  const raw = JSON.parse(readFileSync(absolute, "utf8"));
  const parents = (raw.parents ?? []).map(expandHome);
  if (parents.length === 0) {
    throw new Error("config.parents must list at least one parked directory");
  }

  const ignore = Array.isArray(raw.ignore) ? [...raw.ignore] : [...DEFAULT_IGNORE];
  if (!ignore.includes(META_DIR)) ignore.push(META_DIR);

  return {
    path: absolute,
    parents,
    ignore,
    debounceMs: Number(raw.debounceMs ?? 1000),
    rescanMs: Number(raw.rescanMs ?? 15_000),
    concurrency: Number(raw.concurrency ?? 3),
    notify: {
      enabled: raw.notify?.enabled !== false,
      slowMs: Number(raw.notify?.slowMs ?? 2000),
      delayMs: Number(raw.notify?.delayMs ?? 0),
      onSuccess: Boolean(raw.notify?.onSuccess),
      onFailure: raw.notify?.onFailure !== false,
    },
    ssh: {
      controlPersist: raw.ssh?.controlPersist ?? "10m",
      connectTimeout: Number(raw.ssh?.connectTimeout ?? 15),
      controlDir: expandHome(raw.ssh?.controlDir ?? "~/Library/Caches/sftp-autosync/cm"),
    },
  };
}

export function loadProjectConfig(projectRoot) {
  const file = configPath(projectRoot);
  if (!existsSync(file)) return null;

  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!raw.host || !raw.username || !raw.remotePath) {
    throw new Error(
      `Invalid ${META_DIR}/${CONFIG_FILE} in ${projectRoot}: host, username, and remotePath are required`,
    );
  }
  if (!raw.privateKeyPath) {
    throw new Error(
      `Invalid ${META_DIR}/${CONFIG_FILE} in ${projectRoot}: privateKeyPath is required (SSH key / agent auth only)`,
    );
  }

  return {
    root: resolve(projectRoot),
    name: basename(projectRoot),
    host: raw.host,
    port: Number(raw.port ?? 22),
    username: raw.username,
    privateKeyPath: expandHome(raw.privateKeyPath),
    remotePath: normalizeRemote(raw.remotePath),
    mode: parseProjectMode(raw.mode),
    routes: (raw.routes ?? []).map((route) => ({
      local: route.local.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
      remote: normalizeRemote(route.remote),
    })),
  };
}

function normalizeRemote(path) {
  const cleaned = path.replace(/\\/g, "/");
  if (cleaned === "/") return "/";
  return cleaned.replace(/\/+$/g, "") || "/";
}

/** @typedef {"auto" | "manual"} ProjectSyncMode */

/**
 * Parse project sync mode. Missing or unknown values default to auto for
 * backward compatibility with configs written before mode existed.
 * @param {unknown} raw
 * @returns {ProjectSyncMode}
 */
export function parseProjectMode(raw) {
  if (raw === "manual") return "manual";
  if (raw === "auto") return "auto";
  return "auto";
}

/** SSH identity without key path — remote collisions are about server paths. */
export function projectIdentity(project) {
  return `${project.username}@${project.host}:${project.port}`;
}

/** Default remote path plus every route remote for collision checks. */
export function remoteTargetsForProject(project) {
  const paths = [project.remotePath];
  for (const route of project.routes) {
    paths.push(route.remote);
  }
  return paths;
}

/** True when two normalized remote paths share files (equal or prefix). */
export function remotePathsOverlap(a, b) {
  if (a === b) return true;
  if (a === "/" || b === "/") return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Find parked projects that would write to the same or overlapping remote paths.
 * @param {Map<string, object>} projects
 * @returns {Array<{ kind: "exact" | "overlap", projects: string[], target?: string, identity?: string, paths?: string[] }>}
 */
export function findDuplicateRemoteTargets(projects) {
  /** @type {Map<string, Set<string>>} */
  const byExact = new Map();
  /** @type {Array<{ identity: string, remotePath: string, projectName: string }>} */
  const entries = [];

  for (const project of projects.values()) {
    const identity = projectIdentity(project);
    for (const remotePath of remoteTargetsForProject(project)) {
      const key = `${identity}:${remotePath}`;
      if (!byExact.has(key)) byExact.set(key, new Set());
      byExact.get(key).add(project.name);
      entries.push({ identity, remotePath, projectName: project.name });
    }
  }

  /** @type {Array<{ kind: "exact" | "overlap", projects: string[], target?: string, identity?: string, paths?: string[] }>} */
  const conflicts = [];
  const seen = new Set();

  for (const [target, names] of byExact) {
    if (names.size <= 1) continue;
    const projects = [...names].sort();
    const id = `exact:${target}:${projects.join(",")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    conflicts.push({ kind: "exact", projects, target });
  }

  /** @type {Map<string, typeof entries>} */
  const byIdentity = new Map();
  for (const entry of entries) {
    if (!byIdentity.has(entry.identity)) byIdentity.set(entry.identity, []);
    byIdentity.get(entry.identity).push(entry);
  }

  for (const [identity, list] of byIdentity) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.projectName === b.projectName) continue;
        if (!remotePathsOverlap(a.remotePath, b.remotePath)) continue;
        if (a.remotePath === b.remotePath) continue;

        const projects = [a.projectName, b.projectName].sort();
        const paths = [a.remotePath, b.remotePath].sort();
        const id = `overlap:${identity}:${paths.join("|")}:${projects.join(",")}`;
        if (seen.has(id)) continue;
        seen.add(id);
        conflicts.push({ kind: "overlap", projects, identity, paths });
      }
    }
  }

  return conflicts;
}

export function formatDuplicateRemoteTargetWarning(conflict) {
  if (conflict.kind === "exact") {
    const [a, b, ...rest] = conflict.projects;
    const others = rest.length ? `, ${rest.join(", ")}` : "";
    const pair = rest.length ? `${a}, ${b}${others}` : `${a} and ${b}`;
    return `[config] remote target collision: ${pair} both map to ${conflict.target}`;
  }
  const [a, b] = conflict.projects;
  const [pathA, pathB] = conflict.paths;
  return `[config] remote target overlap: ${a} and ${b} on ${conflict.identity}: ${pathA} and ${pathB}`;
}

/** True when projectDir is a direct child of one of the parked parents. */
export function isParkedProject(projectDir, parents) {
  const absolute = resolve(expandHome(projectDir));
  for (const parent of parents) {
    const parked = resolve(expandHome(parent));
    const rel = relative(parked, absolute);
    if (!rel || rel.startsWith("..") || rel.includes(sep)) continue;
    if (rel.startsWith(".")) continue;
    return true;
  }
  return false;
}

/** Immediate children of parked parents that contain .sftp-autosync/sync-config.json. */
export function discoverProjects(parents) {
  const projects = new Map();

  for (const parent of parents) {
    if (!existsSync(parent)) {
      console.warn(`[config] parked parent missing: ${parent}`);
      continue;
    }

    let entries;
    try {
      entries = readdirSync(parent);
    } catch (err) {
      console.warn(`[config] cannot read ${parent}: ${err.message}`);
      continue;
    }

    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const root = join(parent, name);
      try {
        if (!statSync(root).isDirectory()) continue;
      } catch {
        continue;
      }

      try {
        const project = loadProjectConfig(root);
        if (project) projects.set(project.root, project);
      } catch (err) {
        console.warn(`[config] skip ${root}: ${err.message}`);
      }
    }
  }

  return projects;
}
