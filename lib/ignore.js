import { META_DIR } from "./visibility.js";

/**
 * Whether a project-relative POSIX path should be excluded from watch/push/hash seed.
 * @param {string} relPosix
 * @param {string[]} ignorePatterns
 */
export function shouldIgnoreRel(relPosix, ignorePatterns) {
  const parts = relPosix.split("/");
  const base = parts[parts.length - 1] || "";

  // Never sync local meta/credentials.
  if (parts[0] === META_DIR || base === "sync-config.json") return true;

  for (const pattern of ignorePatterns) {
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

function matchGlob(text, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(text);
}
