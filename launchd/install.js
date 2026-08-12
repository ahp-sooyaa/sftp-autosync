#!/usr/bin/env bun
/**
 * Install/uninstall the login LaunchAgent for sftp-autosync.
 * Usage:
 *   bun launchd/install.js
 *   bun launchd/install.js --uninstall
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installLaunchAgent, uninstallLaunchAgent } from "../lib/launchd-install.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const uninstall = Bun.argv.includes("--uninstall");

if (uninstall) {
  await uninstallLaunchAgent();
  console.log("Uninstalled com.sftp-autosync");
  process.exit(0);
}

const { plistPath, logDir } = await installLaunchAgent({ packageRoot: root });
console.log(`Installed and loaded ${plistPath}`);
console.log(`Logs: ${logDir}/out.log  ${logDir}/err.log`);
