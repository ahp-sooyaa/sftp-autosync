import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { expandHome, isParkedProject, loadGlobalConfig, loadProjectConfig } from "../config.js";
import { listGitChangedPaths } from "../git-changed.js";
import { globalConfigPath } from "../paths.js";
import { pushProject } from "../push.js";
import { SshPool } from "../ssh-pool.js";
import { META_DIR, ProjectVisibility, configPath } from "../visibility.js";
import { ensureInitialized } from "./ensure-init.js";

export function parsePushArgs(argv) {
  const opts = {
    projectDir: null,
    paths: [],
    changed: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--changed") {
      opts.changed = true;
    } else if (arg === "--project" && argv[i + 1]) {
      opts.projectDir = argv[++i];
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!opts.projectDir && isExplicitProjectDirArg(arg) && looksLikeProjectRoot(arg)) {
      // Only absolute/~/./.. args that contain a valid sync-config become projectDir.
      // Relative names like "src" stay push paths even if a nested config exists.
      opts.projectDir = arg;
    } else {
      opts.paths.push(arg);
    }
  }

  if (opts.changed && opts.paths.length > 0) {
    throw new Error("Use --changed without explicit paths (or push specific paths without --changed)");
  }

  return opts;
}

/** True when the CLI token is an explicit directory reference (not a relative path segment). */
export function isExplicitProjectDirArg(arg) {
  return (
    arg === "." ||
    arg === ".." ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.startsWith("/") ||
    arg.startsWith("~/") ||
    arg.startsWith("~\\")
  );
}

/**
 * True when arg resolves to a directory with a valid sync-config.
 * Never throws on corrupt/incomplete config — those are treated as non-roots.
 */
export function looksLikeProjectRoot(arg) {
  const absolute = resolve(expandHome(arg));
  try {
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return false;
  } catch {
    return false;
  }
  return hasValidProjectConfig(absolute);
}

function hasValidProjectConfig(projectRoot) {
  const file = configPath(projectRoot);
  if (!existsSync(file)) return false;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Boolean(raw?.host && raw?.username && raw?.remotePath && raw?.privateKeyPath);
  } catch {
    return false;
  }
}

export function printPushHelp() {
  console.log(`Usage: sftp-autosync push [projectDir] [paths…] [options]

Upload files now (whole project when no paths are given) and update local
content fingerprints under ${META_DIR}/.

Use this for manual-sync projects, or to upload specific files/folders without
waiting for the watcher (similar to an SFTP extension upload shortcut).

Arguments:
  projectDir                 Project root (default: current directory)
  paths                      Files or folders relative to the project

Options:
  --project <dir>            Project root (alternative to positional)
  --changed                  Upload git-changed files (staged, unstaged, untracked)
  --force                    Re-upload even when fingerprint matches
  -h, --help                 Show help

Examples:
  sftp-autosync push
  sftp-autosync push --changed
  sftp-autosync push package.json src/
  sftp-autosync push index.html assets/style.css
  sftp-autosync push ~/Sites/my-app
  sftp-autosync push ~/Sites/my-app public/index.html --force
`);
}

export async function runPush(argv) {
  const opts = parsePushArgs(argv);
  if (opts.help) {
    printPushHelp();
    return;
  }

  await ensureInitialized();

  const globalConfig = loadGlobalConfig(globalConfigPath());
  const projectDir = resolve(expandHome(opts.projectDir || process.cwd()));

  if (!isParkedProject(projectDir, globalConfig.parents)) {
    const parents = globalConfig.parents.map((p) => expandHome(p)).join(", ");
    throw new Error(`Project must be an immediate child of a parked parent (${parents})`);
  }

  const project = loadProjectConfig(projectDir);
  if (!project) {
    throw new Error(`No ${META_DIR}/sync-config.json in ${projectDir} (run: sftp-autosync setup)`);
  }

  const pool = new SshPool({
    ssh: globalConfig.ssh,
    concurrency: globalConfig.concurrency,
  });
  const visibility = new ProjectVisibility({
    notify: globalConfig.notify.enabled,
    slowMs: globalConfig.notify.slowMs,
    delayMs: globalConfig.notify.delayMs,
    onSuccess: globalConfig.notify.onSuccess,
    onFailure: globalConfig.notify.onFailure,
  });

  let pushPaths = opts.paths;
  if (opts.changed) {
    pushPaths = await listGitChangedPaths(projectDir, { ignore: globalConfig.ignore });
    if (pushPaths.length === 0) {
      console.log("[push] nothing to push (no git-changed files)");
      return;
    }
  }

  console.log(
    pushPaths.length
      ? opts.changed
        ? `[push] ${project.name}: git-changed (${pushPaths.length} file${pushPaths.length === 1 ? "" : "s"})`
        : `[push] ${project.name}: ${pushPaths.join(", ")}`
      : `[push] ${project.name}: entire project`,
  );

  try {
    const result = await pushProject({
      project,
      ignore: globalConfig.ignore,
      pool,
      paths: pushPaths,
      visibility,
      skipUnchanged: !opts.force,
    });
    console.log(
      `[push] done ${basename(project.root)}: uploaded=${result.uploaded} skipped=${result.skipped} failed=${result.failed}`,
    );
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await pool.close();
  }
}
