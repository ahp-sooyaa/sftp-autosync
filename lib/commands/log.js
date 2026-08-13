import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleCancel, isInteractive } from "../cli.js";
import { select } from "../prompts.js";
import { daemonErrLogPath, daemonOutLogPath } from "../paths.js";
import { LOG_FILE, metaDir } from "../visibility.js";
import { cwdHasProjectConfig } from "./config.js";

/** @typedef {"daemon-out" | "daemon-err" | "project"} LogSource */

export function parseLogArgs(argv) {
  const opts = {
    err: false,
    project: false,
    projectDir: null,
    path: false,
    noFollow: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--err") {
      opts.err = true;
    } else if (arg === "--project") {
      opts.project = true;
      if (argv[i + 1] && !argv[i + 1].startsWith("-")) {
        opts.projectDir = argv[++i];
      }
    } else if (arg === "--path") {
      opts.path = true;
    } else if (arg === "--no-follow") {
      opts.noFollow = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (opts.err && opts.project) {
    throw new Error("Use only one of --err or --project");
  }

  return opts;
}

export function printLogHelp() {
  console.log(`Usage: sftp-autosync log [options]

Options:
  --err                 Daemon stderr log (default: stdout)
  --project [dir]       Project .sftp-autosync/sync.log (default: cwd)
  --path                Print log file path only
  --no-follow           Print existing contents and exit
  -h, --help            Show help

Default: follow daemon stdout log. In a terminal with no source flag, prompts for a log.
`);
}

/**
 * @returns {{ source: LogSource, path: string }}
 */
export function resolveLogSource(opts, cwd = process.cwd()) {
  if (opts.project) {
    const projectDir = resolve(opts.projectDir ?? cwd);
    return { source: "project", path: resolve(metaDir(projectDir), LOG_FILE) };
  }

  if (opts.err) {
    return { source: "daemon-err", path: daemonErrLogPath() };
  }

  return { source: "daemon-out", path: daemonOutLogPath() };
}

/** Prompt for a log only when no source or output flag is set. */
export function shouldPromptLogSource(opts, interactive) {
  if (!interactive) return false;
  if (opts.project || opts.err) return false;
  if (opts.path || opts.noFollow) return false;
  return true;
}

export async function promptLogSource(opts, cwd = process.cwd(), io) {
  if (opts.project || opts.err) {
    return resolveLogSource(opts, cwd);
  }

  const options = [
    { value: "daemon-out", label: "Daemon stdout", hint: daemonOutLogPath() },
    { value: "daemon-err", label: "Daemon stderr", hint: daemonErrLogPath() },
  ];

  if (cwdHasProjectConfig(cwd)) {
    options.push({
      value: "project",
      label: "This project",
      hint: resolve(metaDir(cwd), LOG_FILE),
    });
  }

  const choice = handleCancel(
    await select(
      {
        message: "Which log?",
        options,
        initialValue: "daemon-out",
      },
      io,
    ),
  );

  if (choice === "daemon-out") {
    return { source: "daemon-out", path: daemonOutLogPath() };
  }
  if (choice === "daemon-err") {
    return { source: "daemon-err", path: daemonErrLogPath() };
  }

  return { source: "project", path: resolve(metaDir(cwd), LOG_FILE) };
}

export async function followLog(filePath, { spawn = (args, opts) => Bun.spawn(args, opts) } = {}) {
  const proc = spawn(["tail", "-f", filePath], { stdio: "inherit" });
  const forward = (signal) => {
    if (!proc.killed) proc.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  try {
    const code = await proc.exited;
    if (isTailInterruptExit(code)) return;
    throw new Error(`tail -f exited with code ${code}`);
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

/** Ctrl+C / SIGTERM on `tail -f` should not look like a CLI failure. */
export function isTailInterruptExit(code) {
  return code === 0 || code === null || code === 130 || code === 143;
}

export async function runLog(
  argv,
  {
    cwd = process.cwd(),
    io,
    spawn = (args, opts) => Bun.spawn(args, opts),
    interactive = isInteractive(),
  } = {},
) {
  const opts = parseLogArgs(argv);
  if (opts.help) {
    printLogHelp();
    return;
  }

  const resolved = shouldPromptLogSource(opts, interactive)
    ? await promptLogSource(opts, cwd, io)
    : resolveLogSource(opts, cwd);
  const { path: filePath } = resolved;

  if (opts.path) {
    console.log(filePath);
    return;
  }

  if (!existsSync(filePath)) {
    console.error(`Log not found: ${filePath}`);
    process.exit(1);
  }

  if (opts.noFollow) {
    process.stdout.write(readFileSync(filePath));
    return;
  }

  await followLog(filePath, { spawn });
}
