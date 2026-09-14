#!/usr/bin/env bun
/**
 * Push demo changes and verify other project's remote tree is untouched.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverProjects, loadGlobalConfig } from "../lib/config.js";
import { pushProject } from "../lib/push.js";
import { SshPool } from "../lib/ssh-pool.js";
import { ProjectVisibility } from "../lib/visibility.js";

const e2eRoot = fileURLToPath(new URL(".", import.meta.url));
const globalConfigPath = join(e2eRoot, "config.json");
const demoDir = join(e2eRoot, "park", "demo");
const otherRemoteDir = join(e2eRoot, "remotes", "other");
const demoRemoteDir = join(e2eRoot, "remotes", "demo");
const otherSentinel = join(otherRemoteDir, "SENTINEL.txt");
const testFile = join(demoDir, "isolation-check.txt");
const testRemote = join(demoRemoteDir, "isolation-check.txt");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertDockerUp() {
  if (!existsSync(globalConfigPath)) {
    throw new Error("e2e config missing — run: bun run e2e:up");
  }
  const probe = Bun.spawnSync(
    ["docker", "inspect", "-f", "{{.State.Running}}", "sftp-autosync-e2e"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const running = new TextDecoder().decode(probe.stdout).trim();
  if (probe.exitCode !== 0 || running !== "true") {
    throw new Error("Docker container sftp-autosync-e2e is not running — run: bun run e2e:up");
  }
}

async function pushDemo(globalConfig, project) {
  const pool = new SshPool({
    ssh: globalConfig.ssh,
    concurrency: globalConfig.concurrency,
  });
  try {
    await pushProject({
      project,
      ignore: globalConfig.ignore,
      pool,
      paths: [testFile],
      visibility: new ProjectVisibility({ notify: false }),
      skipUnchanged: false,
    });
  } finally {
    await pool.close();
  }
}

async function removeDemoRemote(globalConfig, project) {
  const pool = new SshPool({
    ssh: globalConfig.ssh,
    concurrency: globalConfig.concurrency,
  });
  try {
    const remotePath = "/home/deploy/sites/demo/isolation-check.txt";
    await pool.removeFile(project, remotePath);
  } finally {
    await pool.close();
  }
}

async function main() {
  assertDockerUp();

  const globalConfig = loadGlobalConfig(globalConfigPath);
  const projects = discoverProjects(globalConfig.parents);
  const demo = projects.get(resolve(demoDir));
  const other = projects.get(resolve(join(e2eRoot, "park", "other")));

  if (!demo || !other) {
    throw new Error("Expected demo and other projects — run: bun run e2e:up");
  }
  if (!existsSync(otherSentinel)) {
    throw new Error(`Missing ${otherSentinel} — run: bun run e2e:up`);
  }

  const sentinelBefore = sha256(otherSentinel);
  const marker = `isolation-${Date.now()}\n`;
  writeFileSync(testFile, marker);

  console.log("[e2e:isolate] pushing demo-only file…");
  await pushDemo(globalConfig, demo);

  if (!existsSync(testRemote)) {
    throw new Error(`Expected uploaded file at ${testRemote}`);
  }
  if (readFileSync(testRemote, "utf8") !== marker) {
    throw new Error("Demo remote file content mismatch");
  }
  if (sha256(otherSentinel) !== sentinelBefore) {
    throw new Error("Other project remote SENTINEL.txt changed after demo upload");
  }

  console.log("[e2e:isolate] removing demo file locally and on remote…");
  unlinkSync(testFile);
  await removeDemoRemote(globalConfig, demo);

  if (existsSync(testRemote)) {
    throw new Error(`Demo remote file still present at ${testRemote}`);
  }
  if (sha256(otherSentinel) !== sentinelBefore) {
    throw new Error("Other project remote SENTINEL.txt changed after demo delete");
  }
  if (!statSync(otherRemoteDir).isDirectory()) {
    throw new Error(`Other remote dir missing: ${otherRemoteDir}`);
  }

  console.log("[e2e:isolate] pass — demo upload/delete did not affect other remotes");
}

main().catch((err) => {
  console.error(`[e2e:isolate] ${err.message}`);
  process.exit(1);
});
