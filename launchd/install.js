#!/usr/bin/env bun
/**
 * Install/uninstall the login LaunchAgent for sftp-autosync.
 * Usage:
 *   bun launchd/install.js
 *   bun launchd/install.js --uninstall
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const home = homedir();
const label = "com.sftp-autosync";
const plistPath = join(home, "Library/LaunchAgents", `${label}.plist`);
const logDir = join(home, "Library/Logs/sftp-autosync");
const uninstall = Bun.argv.includes("--uninstall");

const bunPath = Bun.which("bun");
if (!bunPath) {
  console.error("bun not found on PATH");
  process.exit(1);
}

async function launchctl(...args) {
  return Bun.spawn(["launchctl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
}

if (uninstall) {
  if (existsSync(plistPath)) {
    await launchctl("unload", plistPath);
    unlinkSync(plistPath);
  }
  console.log(`Uninstalled ${label}`);
  process.exit(0);
}

mkdirSync(logDir, { recursive: true });
mkdirSync(dirname(plistPath), { recursive: true });

const template = readFileSync(join(root, "launchd/com.sftp-autosync.plist.template"), "utf8");
const plist = template
  .replaceAll("__BUN_PATH__", bunPath)
  .replaceAll("__BUN_DIR__", dirname(bunPath))
  .replaceAll("__SYNC_JS_PATH__", join(root, "sync.js"))
  .replaceAll("__CONFIG_PATH__", join(root, "config.json"))
  .replaceAll("__WORKING_DIRECTORY__", root)
  .replaceAll("__HOME__", home);

writeFileSync(plistPath, plist);
chmodSync(plistPath, 0o644);

await launchctl("unload", plistPath);
const load = await Bun.spawn(["launchctl", "load", plistPath], {
  stdout: "inherit",
  stderr: "inherit",
}).exited;

if (load !== 0) {
  console.error("launchctl load failed");
  process.exit(1);
}

console.log(`Installed and loaded ${plistPath}`);
console.log(`Logs: ${logDir}/out.log  ${logDir}/err.log`);
