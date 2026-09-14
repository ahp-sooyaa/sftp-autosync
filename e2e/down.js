#!/usr/bin/env bun
/**
 * Stop the local OpenSSH sandbox container.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const e2eRoot = fileURLToPath(new URL(".", import.meta.url));

const result = spawnSync("docker", ["compose", "down"], {
  cwd: e2eRoot,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("[e2e] sandbox stopped");
