import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleCancel, isInteractive } from "../cli.js";
import { select } from "../prompts.js";
import { globalConfigPath } from "../paths.js";
import { configPath } from "../visibility.js";
import { ensureInitialized } from "./ensure-init.js";

/** @typedef {"global" | "project"} ConfigTarget */
/** @typedef {"print" | "edit" | "path"} ConfigAction */

export function parseConfigArgs(argv) {
  const opts = {
    global: false,
    project: false,
    projectDir: null,
    edit: false,
    path: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--global") {
      opts.global = true;
    } else if (arg === "--project") {
      opts.project = true;
      if (argv[i + 1] && !argv[i + 1].startsWith("-")) {
        opts.projectDir = argv[++i];
      }
    } else if (arg === "--edit") {
      opts.edit = true;
    } else if (arg === "--path") {
      opts.path = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (opts.global && opts.project) {
    throw new Error("Use only one of --global or --project");
  }
  if (opts.edit && opts.path) {
    throw new Error("Use only one of --edit or --path");
  }

  return opts;
}

export function printConfigHelp() {
  console.log(`Usage: sftp-autosync config [options]

Options:
  --global              Application Support config.json
  --project [dir]       Project .sftp-autosync/sync-config.json (default: cwd)
  --edit                Open in $EDITOR (or TextEdit on macOS)
  --path                Print config file path only
  -h, --help            Show help

With no flags, prints the config file (project if cwd has sync-config, else global).
In a terminal, missing choices are prompted interactively.
`);
}

/** True when cwd has a project sync-config file (even if JSON is invalid). */
export function cwdHasProjectConfig(cwd = process.cwd()) {
  return existsSync(configPath(cwd));
}

/**
 * Resolve which config file to use.
 * @returns {{ target: ConfigTarget, path: string, projectDir?: string }}
 */
export function resolveConfigTarget(opts, cwd = process.cwd()) {
  if (opts.global) {
    return { target: "global", path: globalConfigPath() };
  }

  if (opts.project) {
    const projectDir = resolve(opts.projectDir ?? cwd);
    return { target: "project", path: configPath(projectDir), projectDir };
  }

  if (cwdHasProjectConfig(cwd)) {
    return { target: "project", path: configPath(cwd), projectDir: cwd };
  }

  return { target: "global", path: globalConfigPath() };
}

/**
 * Resolve the action to perform.
 * @returns {ConfigAction}
 */
export function resolveConfigAction(opts) {
  if (opts.edit) return "edit";
  if (opts.path) return "path";
  return "print";
}

export async function promptConfigTarget(opts, cwd = process.cwd(), io) {
  if (opts.global || opts.project) {
    return resolveConfigTarget(opts, cwd);
  }

  const defaultTarget = cwdHasProjectConfig(cwd) ? "project" : "global";
  const choice = handleCancel(
    await select(
      {
        message: "Which config?",
        options: [
          {
            value: "global",
            label: "Global",
            hint: "~/Library/Application Support/sftp-autosync/config.json",
          },
          {
            value: "project",
            label: "Project",
            hint: ".sftp-autosync/sync-config.json in cwd",
          },
        ],
        initialValue: defaultTarget,
      },
      io,
    ),
  );

  if (choice === "global") {
    return { target: "global", path: globalConfigPath() };
  }

  const projectDir = resolve(opts.projectDir ?? cwd);
  return { target: "project", path: configPath(projectDir), projectDir };
}

/** Prompt for target only when it is unspecified and no action flag is set. */
export function shouldPromptConfigTarget(opts, interactive) {
  if (!interactive) return false;
  if (opts.global || opts.project) return false;
  if (opts.edit || opts.path) return false;
  return true;
}

/** Prompt for action only when --edit / --path were not given. */
export function shouldPromptConfigAction(opts, interactive) {
  if (!interactive) return false;
  if (opts.edit || opts.path) return false;
  return true;
}

export async function promptConfigAction(opts, io) {
  if (opts.edit) return "edit";
  if (opts.path) return "path";

  return handleCancel(
    await select(
      {
        message: "What would you like to do?",
        options: [
          { value: "print", label: "Print", hint: "show file contents" },
          { value: "edit", label: "Edit", hint: "open in $EDITOR" },
          { value: "path", label: "Show path", hint: "print file path only" },
        ],
        initialValue: "print",
      },
      io,
    ),
  );
}

/** Split $EDITOR / $VISUAL into argv tokens (supports quoted segments). */
export function parseEditorCommand(editor) {
  const tokens = [];
  const re = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match;
  while ((match = re.exec(String(editor).trim())) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }
  return tokens;
}

export async function openInEditor(
  filePath,
  {
    env = process.env,
    spawn = (args, opts) => Bun.spawn(args, opts),
    platform = process.platform,
  } = {},
) {
  const editor = env.EDITOR || env.VISUAL;
  if (editor) {
    const proc = spawn([...parseEditorCommand(editor), filePath], { stdio: "inherit" });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`Editor exited with code ${code}`);
    }
    return;
  }

  if (platform === "darwin") {
    const proc = spawn(["open", "-t", "-W", filePath], { stdio: "inherit" });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`open -t failed with code ${code}`);
    }
    return;
  }

  throw new Error("Set $EDITOR or $VISUAL to edit config");
}

export async function runConfig(
  argv,
  { cwd = process.cwd(), io, openEditor = openInEditor, interactive = isInteractive() } = {},
) {
  const opts = parseConfigArgs(argv);
  if (opts.help) {
    printConfigHelp();
    return;
  }

  const resolved = shouldPromptConfigTarget(opts, interactive)
    ? await promptConfigTarget(opts, cwd, io)
    : resolveConfigTarget(opts, cwd);
  const action = shouldPromptConfigAction(opts, interactive)
    ? await promptConfigAction(opts, io)
    : resolveConfigAction(opts);

  if (resolved.target === "global") {
    await ensureInitialized();
  }

  const { path: filePath, target } = resolved;
  if (!existsSync(filePath)) {
    if (target === "project") {
      throw new Error(`Project config not found: ${filePath}\nRun: sftp-autosync setup`);
    }
    throw new Error(`Global config not found: ${filePath}\nRun: sftp-autosync init`);
  }

  if (action === "path") {
    console.log(filePath);
    return;
  }

  if (action === "edit") {
    console.log(`${target} config: ${filePath}`);
    await openEditor(filePath);
    if (target === "global") {
      console.log("Global config changed. Run: sftp-autosync restart");
    }
    return;
  }

  console.log(`${target} config: ${filePath}`);
  const contents = readFileSync(filePath);
  process.stdout.write(contents);
  if (!contents.toString().endsWith("\n")) {
    process.stdout.write("\n");
  }
}
