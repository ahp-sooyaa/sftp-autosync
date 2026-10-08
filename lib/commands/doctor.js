import { existsSync, readdirSync, statSync } from "node:fs";
import {
  discoverProjects,
  expandHome,
  loadGlobalConfig,
  remoteTargetsForProject,
} from "../config.js";
import { isSafeRemoteTreePath, unsafeRemotePathReason } from "../remote-path.js";
import { sshPoolIdentityKey } from "../ssh-pool.js";
import { readContentHashStore } from "../content-hashes.js";
import { globalConfigPath } from "../paths.js";
import { readPendingStore } from "../pending.js";
import { checkSshConnection } from "../setup.js";
import { isLaunchdInstalled, launchdPlistPath } from "../launchd.js";
import { metaDir } from "../visibility.js";
import { probeLaunchdLoaded, readProjectStatus } from "./status.js";
import { ensureInitialized } from "./ensure-init.js";

export function parseDoctorArgs(argv) {
  const opts = {
    probe: true,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--no-probe") {
      opts.probe = false;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return opts;
}

export function printDoctorHelp() {
  console.log(`Usage: sftp-autosync doctor [options]

One pass/fail health report for launchd, SSH keys, project configs, and
recent sync errors. Read-only.

Options:
  --no-probe            Skip live SSH BatchMode probes (offline / tests)
  -h, --help            Show help
`);
}

/**
 * @typedef {{ name: string, ok: boolean, detail: string }} DoctorCheck
 */

export function formatDoctorLine(check) {
  const mark = check.ok ? "ok" : "fail";
  return `[doctor] ${mark} ${check.name}: ${check.detail}`;
}

export function checkPrivateKeyPath(privateKeyPath) {
  const absolute = expandHome(privateKeyPath);
  if (!existsSync(absolute)) {
    return { ok: false, detail: `missing key ${absolute}` };
  }
  try {
    const mode = statSync(absolute).mode;
    if ((mode & 0o077) !== 0) {
      return { ok: false, detail: `key ${absolute} is group/world accessible (chmod 600)` };
    }
  } catch (err) {
    return { ok: false, detail: err?.message || String(err) };
  }
  return { ok: true, detail: absolute };
}

export function listQuarantineBackups(projectRoot) {
  const dir = metaDir(projectRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(
      (name) =>
        name.startsWith("content-hashes.json.corrupt.") ||
        name.startsWith("pending.json.corrupt."),
    );
  } catch {
    return [];
  }
}

/**
 * @param {object} [deps]
 * @returns {Promise<DoctorCheck[]>}
 */
export async function runDoctorChecks(
  {
    globalConfigPath: configPath = globalConfigPath(),
    probe = true,
    probeLaunchd = probeLaunchdLoaded,
    sshCheck = checkSshConnection,
    connectTimeout = 15,
  } = {},
) {
  /** @type {DoctorCheck[]} */
  const checks = [];

  const plistPath = launchdPlistPath();
  const installed = isLaunchdInstalled();
  checks.push({
    name: "launchd plist",
    ok: installed,
    detail: installed ? plistPath : `not installed (${plistPath})`,
  });

  const launchd = await probeLaunchd();
  checks.push({
    name: "launchd loaded",
    ok: launchd.loaded,
    detail: launchd.detail ?? (launchd.loaded ? "loaded" : "not loaded"),
  });

  let globalConfig;
  try {
    globalConfig = loadGlobalConfig(configPath);
    checks.push({
      name: "global config",
      ok: true,
      detail: configPath,
    });
  } catch (err) {
    checks.push({
      name: "global config",
      ok: false,
      detail: err?.message || String(err),
    });
    return checks;
  }

  const projects = discoverProjects(globalConfig.parents);
  if (projects.size === 0) {
    checks.push({
      name: "projects",
      ok: true,
      detail: "no synced projects under parked parents",
    });
  }

  /** @type {Map<string, object>} identity -> representative project */
  const probeByIdentity = new Map();

  for (const project of projects.values()) {
    const name = project.name;
    const keyCheck = checkPrivateKeyPath(project.privateKeyPath);
    checks.push({
      name: `${name} key`,
      ok: keyCheck.ok,
      detail: keyCheck.detail,
    });

    for (const remotePath of remoteTargetsForProject(project)) {
      if (!isSafeRemoteTreePath(remotePath)) {
        checks.push({
          name: `${name} remotePath`,
          ok: false,
          detail: unsafeRemotePathReason(remotePath) ?? remotePath,
        });
      }
    }

    const hashStore = readContentHashStore(project.root);
    if (hashStore.status === "corrupt") {
      checks.push({
        name: `${name} content-hashes`,
        ok: false,
        detail: "content-hashes.json is corrupt (run sync or push to rebuild)",
      });
    }

    const pendingStore = readPendingStore(project.root);
    if (pendingStore.status === "corrupt") {
      checks.push({
        name: `${name} pending`,
        ok: false,
        detail: "pending.json is corrupt",
      });
    }

    const quarantine = listQuarantineBackups(project.root);
    if (quarantine.length > 0) {
      checks.push({
        name: `${name} quarantine`,
        ok: true,
        detail: `found ${quarantine.length} corrupt backup(s): ${quarantine.join(", ")}`,
      });
    }

    const status = readProjectStatus(project.root);
    if (status.corrupt) {
      checks.push({
        name: `${name} status.json`,
        ok: false,
        detail: "status.json is corrupt or unreadable",
      });
    } else if (status.lastError) {
      const kind = status.lastError.errorKind ? ` [${status.lastError.errorKind}]` : "";
      checks.push({
        name: `${name} lastError`,
        ok: false,
        detail: `${status.lastError.file} — ${status.lastError.error}${kind}`,
      });
    }

    const identity = sshPoolIdentityKey(project);
    if (!probeByIdentity.has(identity)) {
      probeByIdentity.set(identity, project);
    }
  }

  if (probe) {
    for (const [identity, project] of probeByIdentity) {
      const result = await sshCheck(
        {
          host: project.host,
          port: project.port,
          username: project.username,
          privateKeyPath: project.privateKeyPath,
        },
        { connectTimeout },
      );
      checks.push({
        name: `ssh ${identity}`,
        ok: result.ok,
        detail: result.detail,
      });
    }
  } else if (probeByIdentity.size > 0) {
    checks.push({
      name: "ssh probe",
      ok: true,
      detail: `skipped (--no-probe); ${probeByIdentity.size} identity(ies)`,
    });
  }

  return checks;
}

export async function runDoctor(argv, deps = {}) {
  const opts = parseDoctorArgs(argv);
  if (opts.help) {
    printDoctorHelp();
    return;
  }

  await ensureInitialized();

  const checks = await runDoctorChecks({ ...deps, probe: opts.probe });
  let failed = 0;
  for (const check of checks) {
    console.log(formatDoctorLine(check));
    if (!check.ok) failed += 1;
  }

  if (failed > 0) {
    process.exitCode = 1;
    console.log(`[doctor] ${failed} check(s) failed`);
  } else {
    console.log("[doctor] all checks passed");
  }
}
