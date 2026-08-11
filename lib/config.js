import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
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
    debounceMs: Number(raw.debounceMs ?? 200),
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
