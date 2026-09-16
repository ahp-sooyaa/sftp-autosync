import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleCancel, isInteractive } from "../cli.js";
import { select } from "../prompts.js";
import { discoverProjects, expandHome, loadGlobalConfig } from "../config.js";
import { launchdPlistPath, isLaunchdInstalled } from "../launchd.js";
import { globalConfigPath } from "../paths.js";
import { summarizePending } from "../pending.js";
import { STATUS_FILE, configPath, metaDir } from "../visibility.js";
import { cwdHasProjectConfig } from "./config.js";
import { ensureInitialized } from "./ensure-init.js";

export function parseStatusArgs(argv) {
  const opts = {
    projectDir: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!opts.projectDir) {
      opts.projectDir = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return opts;
}

export function printStatusHelp() {
  console.log(`Usage: sftp-autosync status [projectDir] [options]

Arguments:
  projectDir            Show status for one project (default: all parked projects)

Options:
  -h, --help            Show help

In a terminal with no projectDir and a project config in cwd, prompts all vs this project.
`);
}

/**
 * @returns {Promise<{ loaded: boolean, detail?: string }>}
 */
export async function probeLaunchdLoaded({
  launchctl = async (...args) => {
    const proc = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return { code, stdout };
  },
} = {}) {
  const { code, stdout } = await launchctl("list", "com.sftp-autosync");
  if (code !== 0) {
    return { loaded: false, detail: "not loaded" };
  }
  const line = stdout.split("\n").find((row) => row.includes("com.sftp-autosync"));
  return { loaded: Boolean(line), detail: line?.trim() };
}

export function formatDaemonStatus({ plistPath, installed, loaded, detail }) {
  const lines = ["Daemon:"];
  lines.push(`  plist: ${plistPath}`);
  lines.push(`  installed: ${installed ? "yes" : "no"}`);
  lines.push(`  loaded: ${loaded ? "yes" : "no"}`);
  if (detail) lines.push(`  ${detail}`);
  return lines.join("\n");
}

export function readProjectStatus(projectRoot) {
  const file = resolve(metaDir(projectRoot), STATUS_FILE);
  if (!existsSync(file)) {
    return { hasStatus: false, file };
  }

  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      hasStatus: true,
      statusFile: file,
      state: raw.state ?? "unknown",
      op: raw.op ?? null,
      file: raw.file ?? null,
      at: raw.at ?? null,
      error: raw.error ?? null,
      lastError: raw.lastError ?? null,
    };
  } catch {
    return { hasStatus: false, file, corrupt: true };
  }
}

export function formatProjectStatus(project) {
  const status = readProjectStatus(project.root);
  const lines = [`${project.name}:`];
  lines.push(`  host: ${project.host}`);
  lines.push(`  remote: ${project.remotePath}`);

  if (status.corrupt) {
    lines.push(`  status: corrupt (${status.file})`);
    return lines.join("\n");
  }

  if (!status.hasStatus) {
    lines.push("  status: no status yet");
    return lines.join("\n");
  }

  lines.push(`  state: ${status.state}`);
  if (status.op) lines.push(`  op: ${status.op}`);
  if (status.file) lines.push(`  file: ${status.file}`);
  if (status.at) lines.push(`  at: ${status.at}`);
  if (status.error) lines.push(`  error: ${status.error}`);
  if (status.lastError) {
    lines.push(`  lastError: ${status.lastError.file} — ${status.lastError.error}`);
    if (status.lastError.at) lines.push(`  lastErrorAt: ${status.lastError.at}`);
  }

  const pending = summarizePending(project.root);
  if (pending.count > 0) {
    lines.push(`  pending: ${pending.count} op(s)`);
    if (pending.nextAt) {
      lines.push(`  nextRetry: ${new Date(pending.nextAt).toISOString()}`);
    }
  }
  return lines.join("\n");
}

export async function resolveStatusScope(opts, cwd = process.cwd(), io) {
  if (opts.projectDir) {
    return { mode: "one", projectDir: resolve(expandHome(opts.projectDir)) };
  }

  if (!isInteractive() || !cwdHasProjectConfig(cwd)) {
    return { mode: "all" };
  }

  const choice = handleCancel(
    await select(
      {
        message: "Which projects?",
        options: [
          { value: "all", label: "All parked projects", hint: "every synced project" },
          { value: "this", label: "This project", hint: "cwd only" },
        ],
        initialValue: "all",
      },
      io,
    ),
  );

  if (choice === "this") {
    return { mode: "one", projectDir: cwd };
  }

  return { mode: "all" };
}

export async function runStatus(
  argv,
  { cwd = process.cwd(), io, probeLaunchd = probeLaunchdLoaded } = {},
) {
  const opts = parseStatusArgs(argv);
  if (opts.help) {
    printStatusHelp();
    return;
  }

  await ensureInitialized();
  const globalConfig = loadGlobalConfig(globalConfigPath());
  const installed = isLaunchdInstalled();
  const { loaded, detail } = installed ? await probeLaunchd() : { loaded: false };

  console.log(
    formatDaemonStatus({
      plistPath: launchdPlistPath(),
      installed,
      loaded,
      detail,
    }),
  );

  const scope = await resolveStatusScope(opts, cwd, io);
  console.log("");

  if (scope.mode === "one") {
    const projectDir = scope.projectDir;
    if (!existsSync(configPath(projectDir))) {
      throw new Error(
        `Project config not found: ${configPath(projectDir)}\nRun: sftp-autosync setup`,
      );
    }

    const projects = discoverProjects(globalConfig.parents);
    const project = projects.get(resolve(projectDir));
    if (project) {
      console.log(formatProjectStatus(project));
      return;
    }

    const { loadProjectConfig } = await import("../config.js");
    const loadedProject = loadProjectConfig(projectDir);
    if (!loadedProject) {
      throw new Error(`Invalid project config in ${projectDir}`);
    }
    console.log(formatProjectStatus(loadedProject));
    return;
  }

  const projects = discoverProjects(globalConfig.parents);
  if (projects.size === 0) {
    console.log("Projects:\n  (none)");
    return;
  }

  console.log("Projects:");
  const sorted = [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const project of sorted) {
    console.log("");
    console.log(formatProjectStatus(project));
  }
}
