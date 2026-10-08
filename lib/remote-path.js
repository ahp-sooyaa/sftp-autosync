/**
 * Refuse catastrophic or shallow remote paths for deletes, trash, and setup validation.
 * @param {string} remotePath
 */
export function assertSafeRemoteTreePath(remotePath) {
  const detail = unsafeRemotePathReason(remotePath);
  if (detail) {
    throw new Error(`refusing unsafe remote path: ${detail}`);
  }
}

/** @returns {string | null} human reason when unsafe */
export function unsafeRemotePathReason(remotePath) {
  if (!remotePath || !String(remotePath).trim()) return "(empty)";
  const cleaned = String(remotePath).replace(/\\/g, "/").replace(/\/+$/g, "") || "/";
  if (cleaned === "/") return "/";
  const segments = cleaned.split("/").filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === "." || seg === "..") return `invalid segment "${seg}" in ${cleaned}`;
  }
  if (segments.length < 3) {
    return `${cleaned} is too shallow (need at least 3 path segments, e.g. /var/www/my-app)`;
  }
  return null;
}

/** @param {string} remotePath */
export function isSafeRemoteTreePath(remotePath) {
  return unsafeRemotePathReason(remotePath) == null;
}
