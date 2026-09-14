#!/usr/bin/env bun
/**
 * Bootstrap the local OpenSSH sandbox: keys, isolated configs, Docker Compose.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const e2eRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(e2eRoot, "..");
const keysDir = join(e2eRoot, "keys");
const remotesDir = join(e2eRoot, "remotes");
const demoRemoteDir = join(remotesDir, "demo");
const otherRemoteDir = join(remotesDir, "other");
const parkDir = join(e2eRoot, "park");
const demoDir = join(parkDir, "demo");
const otherDir = join(parkDir, "other");
const privateKeyPath = join(keysDir, "id_ed25519");
const publicKeyPath = `${privateKeyPath}.pub`;
const authorizedKeysPath = join(keysDir, "authorized_keys");
const globalConfigPath = join(e2eRoot, "config.json");
const exampleConfigPath = join(repoRoot, "config.example.json");

const projects = [
  { name: "demo", root: demoDir, remotePath: "/home/deploy/sites/demo", remoteDir: demoRemoteDir },
  { name: "other", root: otherDir, remotePath: "/home/deploy/sites/other", remoteDir: otherRemoteDir },
];

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function ensureSshKey() {
  ensureDir(keysDir);
  if (existsSync(privateKeyPath) && existsSync(publicKeyPath)) {
    console.log(`[e2e] reusing key ${privateKeyPath}`);
    return;
  }

  console.log(`[e2e] generating ed25519 key at ${privateKeyPath}`);
  const result = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-f", privateKeyPath, "-N", "", "-C", "sftp-autosync-e2e"],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("ssh-keygen failed");
  }
}

function writeAuthorizedKeys() {
  const pub = readFileSync(publicKeyPath, "utf8").trim();
  writeFileSync(authorizedKeysPath, `${pub}\n`);
  console.log(`[e2e] wrote ${authorizedKeysPath}`);
}

function writeGlobalConfig() {
  const raw = JSON.parse(readFileSync(exampleConfigPath, "utf8"));
  raw.parents = [parkDir];
  raw.notify = {
    ...raw.notify,
    enabled: true,
    onSuccess: true,
    onFailure: true,
  };
  raw.ssh = {
    ...raw.ssh,
    controlDir: join(e2eRoot, ".cm"),
    connectTimeout: 10,
  };
  writeFileSync(globalConfigPath, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`[e2e] wrote ${globalConfigPath}`);
}

function writeProjectConfig(projectRoot, remotePath) {
  const meta = join(projectRoot, ".sftp-autosync");
  ensureDir(meta);
  const config = {
    host: "127.0.0.1",
    port: 2222,
    username: "deploy",
    privateKeyPath,
    remotePath,
  };
  const path = join(meta, "sync-config.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`[e2e] wrote ${path}`);
}

function seedRemoteSentinels() {
  for (const project of projects) {
    ensureDir(project.remoteDir);
    writeFileSync(join(project.remoteDir, "SENTINEL.txt"), `${project.name}-baseline\n`);
  }
}

function ensureGitignoreEntry(projectRoot) {
  const gitignorePath = join(projectRoot, ".gitignore");
  const line = ".sftp-autosync/";
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${line}\n`);
    return;
  }
  const content = readFileSync(gitignorePath, "utf8");
  if (!content.split("\n").some((entry) => entry.trim() === line)) {
    writeFileSync(gitignorePath, content.endsWith("\n") ? `${content}${line}\n` : `${content}\n${line}\n`);
  }
}

function dockerComposeUp() {
  console.log("[e2e] starting Docker Compose (port 2222)…");
  const result = spawnSync("docker", ["compose", "up", "-d", "--build"], {
    cwd: e2eRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("docker compose up failed — is Docker running?");
  }
}

function waitForSsh() {
  console.log("[e2e] waiting for sshd on 127.0.0.1:2222…");
  const maxAttempts = 30;
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const probe = spawnSync(
      "ssh",
      [
        "-p",
        "2222",
        "-i",
        privateKeyPath,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=2",
        "deploy@127.0.0.1",
        "echo",
        "ok",
      ],
      { encoding: "utf8" },
    );
    if (probe.status === 0) {
      console.log("[e2e] sshd is ready");
      return;
    }
    lastError = (probe.stderr || probe.stdout || "").trim();
    Bun.sleepSync(500);
  }
  throw new Error(`sshd did not become ready on port 2222${lastError ? `: ${lastError}` : ""}`);
}

function main() {
  ensureDir(remotesDir);
  ensureDir(dirname(globalConfigPath));
  ensureSshKey();
  writeAuthorizedKeys();
  writeGlobalConfig();
  seedRemoteSentinels();
  for (const project of projects) {
    writeProjectConfig(project.root, project.remotePath);
    ensureGitignoreEntry(project.root);
  }
  dockerComposeUp();
  waitForSsh();

  console.log("");
  console.log("Local sandbox is ready.");
  console.log(`  Parked projects: ${projects.map((p) => p.name).join(", ")}`);
  console.log(`  Demo local:      ${demoDir}`);
  console.log(`  Other local:     ${otherDir}`);
  console.log(`  Demo remote:     ${demoRemoteDir}`);
  console.log(`  Other remote:    ${otherRemoteDir}`);
  console.log(`  Global config:   ${globalConfigPath}`);
  console.log("");
  console.log("Next:");
  console.log("  bun run e2e:start       # foreground watcher (isolated from launchd)");
  console.log("  bun run e2e:isolate     # automated cross-project isolation check");
  console.log("  bun run e2e:down        # stop container");
  console.log("");
  console.log("Unload launchd first if it is running against work projects:");
  console.log("  launchctl unload ~/Library/LaunchAgents/com.sftp-autosync.plist");
}

main();
