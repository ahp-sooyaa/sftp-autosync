import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { launchdPlistPath } from "./launchd.js";
import { migrateLegacyConfig } from "./paths.js";

const label = "com.sftp-autosync";

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Prefer PATH shim (survives brew/npm upgrades); fall back to package CLI. */
export function resolveLaunchdProgramArgs(packageRoot, bunPath, which = (name) => Bun.which(name)) {
  const cliOnPath = which("sftp-autosync");
  if (cliOnPath) {
    return [cliOnPath, "start"];
  }
  return [bunPath, join(packageRoot, "bin/sftp-autosync.js"), "start"];
}

export function buildProgramArgumentsXml(args) {
  return args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n");
}

export async function installLaunchAgent({
  packageRoot,
  bunPath = Bun.which("bun"),
  home = homedir(),
  launchctl = async (...args) =>
    Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" }).exited,
} = {}) {
  if (!bunPath) {
    throw new Error("bun not found on PATH");
  }

  const plistPath = launchdPlistPath();
  const logDir = join(home, "Library/Logs/sftp-autosync");

  mkdirSync(logDir, { recursive: true });
  mkdirSync(dirname(plistPath), { recursive: true });

  migrateLegacyConfig(packageRoot);

  const programArgs = resolveLaunchdProgramArgs(packageRoot, bunPath);
  const template = readFileSync(
    join(packageRoot, "launchd/com.sftp-autosync.plist.template"),
    "utf8",
  );
  const plist = template
    .replaceAll("__PROGRAM_ARGUMENTS__", buildProgramArgumentsXml(programArgs))
    .replaceAll("__BUN_DIR__", dirname(bunPath))
    .replaceAll("__HOME__", home);

  writeFileSync(plistPath, plist);
  chmodSync(plistPath, 0o644);

  if (existsSync(plistPath)) {
    await launchctl("unload", plistPath);
  }
  const load = await launchctl("load", plistPath);
  if (load !== 0) {
    throw new Error("launchctl load failed");
  }

  return { plistPath, logDir, label };
}

export async function uninstallLaunchAgent({
  launchctl = async (...args) =>
    Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" }).exited,
} = {}) {
  const plistPath = launchdPlistPath();
  if (existsSync(plistPath)) {
    await launchctl("unload", plistPath);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(plistPath);
  }
  return { label };
}
