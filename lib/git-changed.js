import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { shouldIgnoreRel } from "./ignore.js";

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {typeof Bun.spawn} spawn
 */
async function runGit(cwd, args, spawn) {
  const proc = spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** Parse NUL-separated git output into project-relative POSIX paths. */
export function parseNullSeparatedPaths(output) {
  if (!output) return [];
  const trimmed = output.endsWith("\0") ? output.slice(0, -1) : output;
  if (!trimmed) return [];
  return trimmed.split("\0").filter(Boolean);
}

/**
 * List git-changed paths under a project root (staged, unstaged vs HEAD, untracked).
 * Skips deletes and paths excluded by ignore rules or missing on disk.
 *
 * @param {string} projectRoot
 * @param {object} [opts]
 * @param {string[]} [opts.ignore]
 * @param {typeof Bun.spawn} [opts.spawn]
 * @returns {Promise<string[]>} sorted project-relative POSIX paths
 */
export async function listGitChangedPaths(
  projectRoot,
  { ignore = [], spawn = Bun.spawn.bind(Bun) } = {},
) {
  const cwd = resolve(projectRoot);

  const gitVersion = await runGit(cwd, ["--version"], spawn);
  if (gitVersion.exitCode !== 0) {
    throw new Error("git is not available (required for --changed)");
  }

  const revParse = await runGit(cwd, ["rev-parse", "--git-dir"], spawn);
  if (revParse.exitCode !== 0) {
    throw new Error(`Not a git repository: ${cwd}`);
  }

  const vsHead = await runGit(
    cwd,
    ["diff", "--name-only", "-z", "--diff-filter=ACMR", "HEAD"],
    spawn,
  );
  if (vsHead.exitCode !== 0) {
    throw new Error(`git diff failed: ${(vsHead.stderr || vsHead.stdout).trim()}`);
  }

  const untracked = await runGit(
    cwd,
    ["ls-files", "-z", "--others", "--exclude-standard"],
    spawn,
  );
  if (untracked.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${(untracked.stderr || untracked.stdout).trim()}`);
  }

  const shouldIgnore = (rel) => shouldIgnoreRel(rel, ignore);
  const seen = new Set();
  /** @type {string[]} */
  const paths = [];

  for (const rel of [
    ...parseNullSeparatedPaths(vsHead.stdout),
    ...parseNullSeparatedPaths(untracked.stdout),
  ]) {
    const normalized = rel.split(/\\|\//).join("/");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    if (shouldIgnore(normalized)) continue;
    const absolute = join(cwd, normalized);
    if (!existsSync(absolute)) continue;
    paths.push(normalized);
  }

  return paths.sort();
}
