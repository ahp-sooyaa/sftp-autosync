#!/usr/bin/env bun
import { expandHome, loadGlobalConfig } from "./lib/config.js";
import { resolveConfigArg, resolveGlobalConfigPath } from "./lib/paths.js";
import { SshPool } from "./lib/ssh-pool.js";
import { ProjectWatcher } from "./lib/watcher.js";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

function parseArgs(argv) {
  let configPath = resolveGlobalConfigPath(packageRoot);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && argv[i + 1]) {
      configPath = resolveConfigArg(argv[++i], packageRoot);
    }
  }
  return { configPath };
}

async function main() {
  const { configPath } = parseArgs(Bun.argv.slice(2));
  const globalConfig = loadGlobalConfig(configPath);

  console.log(`[sftp-autosync] config ${globalConfig.path}`);
  console.log(`[sftp-autosync] parents: ${globalConfig.parents.join(", ") || "(none)"}`);

  const pool = new SshPool({
    ssh: globalConfig.ssh,
    concurrency: globalConfig.concurrency,
  });
  const watcher = new ProjectWatcher(globalConfig, pool);
  watcher.start();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[sftp-autosync] shutting down (${signal})`);
    try {
      await watcher.stop();
      await pool.close();
    } catch (err) {
      console.error(`[sftp-autosync] shutdown error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  console.log("[sftp-autosync] watching — Ctrl+C to stop");
  // Keep process alive.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`[sftp-autosync] fatal: ${err.message}`);
  process.exit(1);
});
