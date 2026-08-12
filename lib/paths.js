import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome } from "./config.js";

/** @type {string | null} test override */
let userDataDirOverride = null;

/** Point user data at a temp dir in tests. */
export function setUserDataDirForTests(dir) {
  userDataDirOverride = dir;
}

export function clearUserDataDirForTests() {
  userDataDirOverride = null;
}

/** macOS Application Support directory for sftp-autosync user state. */
export function userDataDir() {
  if (userDataDirOverride) return userDataDirOverride;
  return join(homedir(), "Library", "Application Support", "sftp-autosync");
}

export function globalConfigPath() {
  return join(userDataDir(), "config.json");
}

/** Packaged example config shipped with the installed package. */
export function exampleConfigPath(packageRoot) {
  return join(packageRoot, "config.example.json");
}

/** Pre-0.2.0 config next to the package checkout. */
export function legacyConfigPath(packageRoot) {
  return join(packageRoot, "config.json");
}

export function isInitialized() {
  return existsSync(globalConfigPath());
}

export function ensureUserDataDir() {
  const dir = userDataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Copy legacy package-local config.json into Application Support when missing.
 * @returns {{ migrated: boolean, path: string, from?: string }}
 */
export function migrateLegacyConfig(packageRoot) {
  const target = globalConfigPath();
  if (existsSync(target)) {
    return { migrated: false, path: target };
  }

  const legacy = legacyConfigPath(packageRoot);
  if (!existsSync(legacy)) {
    return { migrated: false, path: target };
  }

  ensureUserDataDir();
  copyFileSync(legacy, target);
  return { migrated: true, path: target, from: legacy };
}

/** Migrate legacy config if needed, then return the global config path. */
export function resolveGlobalConfigPath(packageRoot) {
  migrateLegacyConfig(packageRoot);
  return globalConfigPath();
}

/**
 * Resolve --config, redirecting legacy package-local paths to Application Support.
 */
export function resolveConfigArg(requested, packageRoot) {
  const canonical = resolveGlobalConfigPath(packageRoot);
  if (!requested) return canonical;

  const absolute = resolve(expandHome(requested));
  if (absolute === resolve(legacyConfigPath(packageRoot))) {
    return canonical;
  }
  return absolute;
}
