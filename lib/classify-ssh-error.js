/** @typedef {"auth" | "connect" | "permission" | "space" | "hostkey"} SshErrorKind */

/**
 * Classify OpenSSH / scp error text for status.json and CLI output.
 * @param {string} message
 * @returns {SshErrorKind | null}
 */
export function classifySshError(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return null;

  if (
    text.includes("host key verification failed") ||
    text.includes("remote host identification has changed") ||
    (text.includes("offending") && text.includes("key"))
  ) {
    return "hostkey";
  }

  if (
    text.includes("no space left on device") ||
    text.includes("disk quota exceeded") ||
    text.includes("quota exceeded")
  ) {
    return "space";
  }

  if (
    text.includes("permission denied (publickey") ||
    text.includes("permission denied, please try again") ||
    text.includes("authentication failed") ||
    text.includes("no supported authentication methods") ||
    text.includes("publickey authentication failed")
  ) {
    return "auth";
  }

  if (
    text.includes("connection refused") ||
    text.includes("connection timed out") ||
    text.includes("timed out") ||
    text.includes("could not resolve hostname") ||
    text.includes("name or service not known") ||
    text.includes("no route to host") ||
    text.includes("network is unreachable") ||
    text.includes("broken pipe") ||
    text.includes("connection reset")
  ) {
    return "connect";
  }

  if (
    text.includes("read-only file system") ||
    text.includes("operation not permitted") ||
    (text.includes("permission denied") && !text.includes("publickey"))
  ) {
    return "permission";
  }

  return null;
}
