#!/usr/bin/env bun
/**
 * sftp-autosync CLI
 *
 *   sftp-autosync              interactive command menu (TTY)
 *   sftp-autosync init
 *   sftp-autosync setup
 *   sftp-autosync config
 *   sftp-autosync list
 *   sftp-autosync status
 *   sftp-autosync log
 *   sftp-autosync push
 *   sftp-autosync start
 *   sftp-autosync restart
 *
 * After `bun link` from this repo, the command is on your PATH.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { isInteractive, printHelp, promptCommand, repoRoot } from "../lib/cli.js";
import { runInit } from "../lib/commands/init.js";
import { ensureInitialized } from "../lib/commands/ensure-init.js";
import { runConfig } from "../lib/commands/config.js";
import { runList } from "../lib/commands/list.js";
import { runStatus } from "../lib/commands/status.js";
import { runLog } from "../lib/commands/log.js";
import { runRestart } from "../lib/commands/restart.js";
import { runPush } from "../lib/commands/push.js";
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

async function dispatch(command, rest) {
  if (command === "help") {
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

  if (command === "config") {
    await runConfig(rest);
    return;
  }

  if (command === "list") {
    await runList(rest);
    return;
  }

  if (command === "status") {
    await runStatus(rest);
    return;
  }

  if (command === "log") {
    await runLog(rest);
    return;
  }

  if (command === "push") {
    await runPush(rest);
    return;
  }

  if (command === "start") {
    await runStart(rest);
    return;
  }

  if (command === "restart") {
    await runRestart(rest);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

async function main() {
  const argv = Bun.argv.slice(2);
  let command = argv[0];
  let rest = argv.slice(1);

  if (command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (!command) {
    if (isInteractive()) {
      command = await promptCommand();
      rest = [];
    } else {
      printHelp();
      return;
    }
  }

  await dispatch(command, rest);
}

main().catch((err) => {
  console.error(`sftp-autosync: ${err.message}`);
  process.exit(1);
});
