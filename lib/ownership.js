import { fingerprintHash, readContentHashStore } from "./content-hashes.js";

/**
 * Whether the project already owns this absolute path (known fingerprint).
 * @param {Map<string, import("./content-hashes.js").ContentFingerprint>} baseline
 * @param {string} absolute
 */
export function hasOwnedFingerprint(baseline, absolute) {
  return fingerprintHash(baseline.get(absolute)) != null;
}

/**
 * @returns {{ blocked: boolean, reason?: string }}
 */
export function checkNonemptyStorePush({ baselineSize, remoteProbe, adopt, force, seeded }) {
  if (force || adopt || seeded) return { blocked: false };
  if (baselineSize > 0) return { blocked: false };
  if (!remoteProbe || remoteProbe.status === "missing" || remoteProbe.status === "empty") {
    return { blocked: false };
  }
  return {
    blocked: true,
    reason: `remote ${remoteProbe.remotePath} already has ${remoteProbe.count} item(s); use --already-synced, --adopt, or --force`,
  };
}

/**
 * @returns {{ blocked: boolean, reason?: string }}
 */
export function checkUnownedOverwrite({ hasFingerprint, remoteExists, force, adopt }) {
  if (force || adopt) return { blocked: false };
  if (hasFingerprint) return { blocked: false };
  if (!remoteExists) return { blocked: false };
  return {
    blocked: true,
    reason: "remote file exists but is not owned by this project (no fingerprint); use --force or --adopt",
  };
}

export function loadBaselineFingerprints(projectRoot) {
  const loaded = readContentHashStore(projectRoot);
  if (loaded.status === "corrupt") return new Map();
  return loaded.map;
}
