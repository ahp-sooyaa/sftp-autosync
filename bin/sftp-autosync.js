#!/usr/bin/env bun
/**
 * sftp-autosync CLI
 *
 *   sftp-autosync init
 *   sftp-autosync setup
 *   sftp-autosync start
 *
 * After `bun link` from this repo, the command is on your PATH.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { printHelp, repoRoot } from "../lib/cli.js";
import { runInit } from "../lib/commands/init.js";
import { ensureInitialized } from "../lib/commands/ensure-init.js";
import { runSetup } from "../lib/commands/setup.js";

async function runStart(argv) {
  await ensureInitialized();

  const syncJs = resolve(repoRoot, "sync.js");
  const child = spawn("bun", [syncJs, ...argv], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  const code = await new Promise((resolvePromise) => {
    child.on("exit", (exitCode, signal) => {
      if (signal) resolvePromise(1);
      else resolvePromise(exitCode ?? 1);
    });
  });
  process.exit(code);
}

async function main() {
  const argv = Bun.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "init") {
    await runInit(rest);
    return;
  }

  if (command === "setup") {
    await runSetup(rest);
    return;
  }

  if (command === "start") {
    await runStart(rest);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(`sftp-autosync: ${err.message}`);
  process.exit(1);
});
