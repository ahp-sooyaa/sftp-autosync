import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expandHome } from "./config.js";
import { CONFIG_FILE, META_DIR, configPath, metaDir } from "./visibility.js";

const GITIGNORE_ENTRY = ".sftp-autosync/";

/**
 * Write `.sftp-autosync/sync-config.json` for a project.
 * @returns {{ path: string, created: boolean, config: object }}
 */
export function createProjectConfig({
  projectRoot,
  host,
  port = 22,
  username,
  privateKeyPath,
  remotePath,
  routes = [],
  mode = "manual",
  force = false,
}) {
  const root = resolve(expandHome(projectRoot));
  if (!existsSync(root)) {
    throw new Error(`Project directory not found: ${root}`);
  }

  const file = configPath(root);
  if (existsSync(file) && !force) {
    throw new Error(
      `${META_DIR}/${CONFIG_FILE} already exists (use --force to overwrite): ${file}`,
    );
  }

  if (!host || !username || !privateKeyPath || !remotePath) {
    throw new Error("host, username, privateKeyPath, and remotePath are required");
  }
  if (mode !== "auto" && mode !== "manual") {
    throw new Error('mode must be "auto" or "manual"');
  }

  let routesToWrite = routes;
  if (force && existsSync(file) && routesToWrite.length === 0) {
    try {
      const existing = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(existing.routes) && existing.routes.length > 0) {
        routesToWrite = existing.routes;
      }
    } catch {
      // ignore unreadable existing config
    }
  }

  const config = {
    host: String(host),
    port: Number(port) || 22,
    username: String(username),
    privateKeyPath: String(privateKeyPath),
    remotePath: String(remotePath),
    mode,
  };

  if (Array.isArray(routesToWrite) && routesToWrite.length > 0) {
    config.routes = routesToWrite.map((route) => ({
      local: String(route.local),
      remote: String(route.remote),
    }));
  }

  mkdirSync(metaDir(root), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);

  return { path: file, created: true, config, root, name: basename(root) };
}

/**
 * Update only sync mode in an existing project config.
 * @returns {{ path: string, mode: "auto" | "manual" }}
 */
export function patchProjectMode(projectRoot, mode) {
  if (mode !== "auto" && mode !== "manual") {
    throw new Error('mode must be "auto" or "manual"');
  }

  const root = resolve(expandHome(projectRoot));
  const file = configPath(root);
  if (!existsSync(file)) {
    throw new Error(`No ${META_DIR}/${CONFIG_FILE} in ${root}`);
  }

  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.mode = mode;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  return { path: file, mode };
}

/**
 * Ensure `.sftp-autosync/` is listed in the project's `.gitignore`.
 * @returns {{ path: string, updated: boolean }}
 */
export function ensureGitignore(projectRoot) {
  const root = resolve(expandHome(projectRoot));
  const gitignorePath = join(root, ".gitignore");
  let content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const lines = content.split(/\r?\n/);
  const already = lines.some((line) => {
    const trimmed = line.trim();
    return (
      trimmed === GITIGNORE_ENTRY ||
      trimmed === META_DIR ||
      trimmed === `/${GITIGNORE_ENTRY}` ||
      trimmed === `/${META_DIR}`
    );
  });

  if (already) {
    return { path: gitignorePath, updated: false };
  }

  if (content.length > 0 && !content.endsWith("\n")) {
    content += "\n";
  }
  content += `${GITIGNORE_ENTRY}\n`;
  writeFileSync(gitignorePath, content);
  return { path: gitignorePath, updated: true };
}

/**
 * BatchMode SSH probe (key auth only). Inject `spawn` for tests.
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function checkSshConnection(
  { host, port = 22, username, privateKeyPath },
  { spawn = Bun.spawn.bind(Bun), connectTimeout = 15 } = {},
) {
  const key = expandHome(privateKeyPath);
  const target = `${username}@${host}`;
  const args = [
    "-i",
    key,
    "-p",
    String(port),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `ConnectTimeout=${connectTimeout}`,
    target,
    "true",
  ];

  const proc = spawn(["ssh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode === 0) {
    return { ok: true, detail: `ssh ${target} ok` };
  }

  const detail = (stderr || stdout || `exit ${exitCode}`).trim();
  return { ok: false, detail };
}
