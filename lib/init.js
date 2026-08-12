import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expandHome } from "./config.js";
import { ensureUserDataDir, exampleConfigPath, globalConfigPath } from "./paths.js";

/**
 * Create global config.json from the example (overwrite with --force).
 * @returns {{ created: boolean, path: string, parents: string[] }}
 */
export function createGlobalConfig({ configPath, examplePath, parents, force = false }) {
  const absoluteConfig = expandHome(configPath);
  const absoluteExample = expandHome(examplePath);
  const parentList = (parents?.length ? parents : ["~/Sites"])
    .map((p) => String(p).trim())
    .filter(Boolean);

  if (!parentList.length) {
    throw new Error("At least one parent directory is required");
  }

  if (existsSync(absoluteConfig) && !force) {
    const raw = JSON.parse(readFileSync(absoluteConfig, "utf8"));
    return {
      created: false,
      path: absoluteConfig,
      parents: (raw.parents ?? parentList).map(String),
    };
  }

  if (!existsSync(absoluteExample)) {
    throw new Error(`Example config not found: ${absoluteExample}`);
  }

  const raw = JSON.parse(readFileSync(absoluteExample, "utf8"));
  raw.parents = parentList;
  mkdirSync(dirname(absoluteConfig), { recursive: true });
  writeFileSync(absoluteConfig, `${JSON.stringify(raw, null, 2)}\n`);

  return {
    created: true,
    path: absoluteConfig,
    parents: parentList,
  };
}

/** Ensure each parked parent directory exists (expands ~). */
export function ensureParentDirs(parents) {
  const created = [];
  for (const parent of parents) {
    const absolute = expandHome(parent);
    if (!existsSync(absolute)) {
      mkdirSync(absolute, { recursive: true });
      created.push(absolute);
    }
  }
  return created;
}

export function defaultPaths(packageRoot) {
  return {
    configPath: globalConfigPath(),
    examplePath: exampleConfigPath(packageRoot),
    packageRoot,
  };
}
