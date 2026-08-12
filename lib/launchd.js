import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function launchdPlistPath() {
  return join(homedir(), "Library/LaunchAgents/com.sftp-autosync.plist");
}

export function isLaunchdInstalled() {
  return existsSync(launchdPlistPath());
}
