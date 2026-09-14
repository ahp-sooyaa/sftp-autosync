import { cancel, confirm, intro, outro, select, text } from "../prompts.js";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { discoverSshPrivateKeys, handleCancel, isInteractive } from "../cli.js";
import { expandHome, isParkedProject, loadGlobalConfig, loadProjectConfig } from "../config.js";
import { seedContentHashesFromDisk } from "../content-hashes.js";
import { shouldIgnoreRel } from "../ignore.js";
import { ensureParentDirs } from "../init.js";
import { isLaunchdInstalled } from "../launchd.js";
import { globalConfigPath } from "../paths.js";
import { pushProject } from "../push.js";
import { checkSshConnection, createProjectConfig, ensureGitignore, patchProjectMode } from "../setup.js";
import { SshPool } from "../ssh-pool.js";
import { CONFIG_FILE, META_DIR, ProjectVisibility, configPath } from "../visibility.js";
import { ensureInitialized } from "./ensure-init.js";

/** @typedef {"seed" | "push" | "skip" | null} SyncBootstrap */
/** @typedef {"auto" | "manual" | null} SyncMode */

export function parseSetupArgs(argv) {
  const opts = {
    projectDir: null,
    host: null,
    port: null,
    username: null,
    privateKeyPath: null,
    remotePath: null,
    force: null,
    check: null,
    /** @type {SyncBootstrap} */
    syncBootstrap: null,
    /** @type {SyncMode} */
    mode: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--check") {
      opts.check = true;
    } else if (arg === "--no-check") {
      opts.check = false;
    } else if (arg === "--manual") {
      if (opts.mode === "auto") {
        throw new Error("Use only one of --manual or --autosync");
      }
      opts.mode = "manual";
    } else if (arg === "--autosync") {
      if (opts.mode === "manual") {
        throw new Error("Use only one of --manual or --autosync");
      }
      opts.mode = "auto";
    } else if (arg === "--already-synced") {
      opts.syncBootstrap = "seed";
    } else if (arg === "--push") {
      opts.syncBootstrap = "push";
    } else if (arg === "--no-push") {
      opts.syncBootstrap = "skip";
    } else if (arg === "--host" && argv[i + 1]) {
      opts.host = argv[++i];
    } else if (arg === "--port" && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (arg === "--username" && argv[i + 1]) {
      opts.username = argv[++i];
    } else if ((arg === "--private-key" || arg === "--privateKeyPath") && argv[i + 1]) {
      opts.privateKeyPath = argv[++i];
    } else if ((arg === "--remote-path" || arg === "--remotePath") && argv[i + 1]) {
      opts.remotePath = argv[++i];
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

/** True when setup should only patch sync mode on an existing config. */
export function isModeOnlySetup(opts, existingConfig) {
  if (!existingConfig || opts.force) return false;
  if (opts.mode == null) return false;
  if (
    opts.host ||
    opts.username ||
    opts.remotePath ||
    opts.privateKeyPath ||
    opts.port != null ||
    opts.syncBootstrap != null
  ) {
    return false;
  }
  return true;
}

export function printSetupHelp() {
  console.log(`Usage: sftp-autosync setup [projectDir] [options]

Arguments:
  projectDir                 Project root (default: current directory)

Options:
  --host <host>              SFTP/SSH host
  --port <port>              SSH port (default: 22)
  --username <user>          SSH username
  --private-key <path>       Private key path (default: ~/.ssh/id_ed25519)
  --remote-path <path>       Absolute remote project path
  --manual                   Manual sync — upload with push only (default for new setup)
  --autosync                 Watch and upload on file change
  --force                    Overwrite existing sync-config.json
  --check                    Probe SSH with BatchMode after writing config
  --no-check                 Skip SSH probe (default when non-interactive)
  --already-synced           Trust remote matches local; seed content hashes only
  --push                     Upload the whole project after setup
  --no-push                  Skip seed/push (default when non-interactive)
  -h, --help                 Show help

Switch an existing project to manual without rewriting host/key:
  sftp-autosync setup --manual
  sftp-autosync restart
`);
}

async function promptPrivateKey(existing) {
  if (existing) return existing;

  const keys = discoverSshPrivateKeys();
  if (keys.length === 0) {
    return handleCancel(
      await text({
        message: "Private key path",
        placeholder: "~/.ssh/id_ed25519",
        defaultValue: "~/.ssh/id_ed25519",
        validate: (value) => {
          if (!String(value || "").trim()) return "Private key path is required";
        },
      }),
    );
  }

  const selected = handleCancel(
    await select({
      message: "SSH private key",
      options: [
        ...keys.map((key) => ({
          value: key.display,
          label: key.display,
        })),
        { value: "__custom__", label: "Enter a custom path…" },
      ],
      initialValue: keys[0].display,
    }),
  );

  if (selected !== "__custom__") return selected;

  return handleCancel(
    await text({
      message: "Private key path",
      placeholder: "~/.ssh/id_ed25519",
      defaultValue: "~/.ssh/id_ed25519",
      validate: (value) => {
        if (!String(value || "").trim()) return "Private key path is required";
      },
    }),
  );
}

export async function runSetup(argv) {
  const opts = parseSetupArgs(argv);
  if (opts.help) {
    printSetupHelp();
    return;
  }

  const interactive = isInteractive();
  const projectDir = resolve(expandHome(opts.projectDir || process.cwd()));
  const projectName = basename(projectDir);
  const existingConfig = existsSync(configPath(projectDir));

  if (!existsSync(projectDir)) {
    throw new Error(`Project directory not found: ${projectDir}`);
  }

  await ensureInitialized();

  const globalConfig = loadGlobalConfig(globalConfigPath());
  ensureParentDirs(globalConfig.parents);

  if (!isParkedProject(projectDir, globalConfig.parents)) {
    const parents = globalConfig.parents.map((p) => expandHome(p)).join(", ");
    throw new Error(`Project must be an immediate child of a parked parent (${parents})`);
  }

  if (isModeOnlySetup(opts, existingConfig)) {
    const patched = patchProjectMode(projectDir, opts.mode);
    console.log(`Updated ${patched.path} → mode: ${patched.mode}`);
    if (isLaunchdInstalled()) {
      console.log("Run: sftp-autosync restart");
    }
    return;
  }

  if (interactive) {
    intro(`sftp-autosync setup · ${projectName}`);
  }

  let force = opts.force === true;
  if (existingConfig && opts.force == null) {
    if (!interactive) {
      throw new Error(`${META_DIR}/${CONFIG_FILE} already exists (use --force to overwrite)`);
    }
    const overwrite = handleCancel(
      await confirm({
        message: `${META_DIR}/${CONFIG_FILE} already exists. Overwrite?`,
        active: "Overwrite",
        inactive: "Keep existing",
        initialValue: false,
      }),
    );
    if (!overwrite) {
      cancel("Kept existing project config.");
      process.exit(0);
    }
    force = true;
  }

  let host = opts.host;
  let port = opts.port;
  let username = opts.username;
  let privateKeyPath = opts.privateKeyPath;
  let remotePath = opts.remotePath;

  if (interactive) {
    host =
      host ??
      handleCancel(
        await text({
          message: "SSH host",
          placeholder: "sftp.example.com",
          validate: (value) => {
            if (!String(value || "").trim()) return "Host is required";
          },
        }),
      );

    if (port == null) {
      const portAnswer = handleCancel(
        await text({
          message: "SSH port",
          placeholder: "22",
          defaultValue: "22",
          validate: (value) => {
            const n = Number(value);
            if (!Number.isInteger(n) || n < 1 || n > 65535) return "Enter a port 1–65535";
          },
        }),
      );
      port = Number(portAnswer) || 22;
    }

    username =
      username ??
      handleCancel(
        await text({
          message: "SSH username",
          placeholder: "deploy",
          defaultValue: "deploy",
          validate: (value) => {
            if (!String(value || "").trim()) return "Username is required";
          },
        }),
      );

    privateKeyPath = await promptPrivateKey(privateKeyPath);

    remotePath =
      remotePath ??
      handleCancel(
        await text({
          message: "Remote project path",
          placeholder: `/var/www/${projectName}`,
          defaultValue: `/var/www/${projectName}`,
          validate: (value) => {
            const v = String(value || "").trim();
            if (!v) return "Remote path is required";
            if (!v.startsWith("/")) return "Remote path must be absolute (start with /)";
          },
        }),
      );
  } else {
    const missing = [];
    if (!host) missing.push("--host");
    if (!username) missing.push("--username");
    if (!remotePath) missing.push("--remote-path");
    if (missing.length) {
      throw new Error(
        `Non-interactive setup requires: ${missing.join(", ")} (or run in a terminal)`,
      );
    }
    port = port ?? 22;
    privateKeyPath = privateKeyPath ?? "~/.ssh/id_ed25519";
  }

  let mode = opts.mode;
  if (mode == null) {
    if (interactive) {
      mode = handleCancel(
        await select({
          message: "Sync mode",
          options: [
            {
              value: "manual",
              label: "Manual",
              hint: "upload with sftp-autosync push (file, files, or folder)",
            },
            {
              value: "auto",
              label: "Autosync",
              hint: "watch and upload on file change",
            },
          ],
          initialValue: "manual",
        }),
      );
    } else {
      mode = "manual";
    }
  }

  const result = createProjectConfig({
    projectRoot: projectDir,
    host,
    port,
    username,
    privateKeyPath,
    remotePath,
    mode,
    force,
  });
  console.log(`Wrote ${result.path}`);

  const gi = ensureGitignore(projectDir);
  if (gi.updated) {
    console.log(`Updated ${gi.path}`);
  } else {
    console.log(`.gitignore already ignores ${META_DIR}/`);
  }

  let doCheck = opts.check;
  if (doCheck == null) {
    if (!interactive) {
      doCheck = false;
    } else {
      doCheck = handleCancel(
        await confirm({
          message: "Test SSH connection now?",
          active: "Yes",
          inactive: "Skip",
          initialValue: true,
        }),
      );
    }
  }

  let sshOk = true;
  if (doCheck) {
    console.log("Checking SSH…");
    const probe = await checkSshConnection(result.config);
    if (probe.ok) {
      console.log(probe.detail);
    } else {
      sshOk = false;
      console.error(`SSH check failed: ${probe.detail}`);
      process.exitCode = 1;
    }
  }

  const bootstrap = await resolveSyncBootstrap(opts.syncBootstrap, interactive);
  await applySyncBootstrap({
    bootstrap,
    projectDir,
    globalConfig,
    sshOk,
    checkedSsh: doCheck === true,
  });

  const nextStep = !sshOk
    ? "Config saved — fix SSH auth, then: sftp-autosync push  (or setup --check)"
    : mode === "manual"
      ? "Done. Upload with: sftp-autosync push [paths…]"
      : isLaunchdInstalled()
        ? "Done. The launchd agent will sync this project automatically. Run: sftp-autosync restart"
        : "Done. Start sync with: sftp-autosync start";

  if (interactive) {
    outro(nextStep);
  } else {
    console.log(nextStep);
  }
}

/**
 * Apply setup-time seed / full push / skip after config is written.
 * Seed does not need SSH; push is skipped when a failed probe already proved auth is broken.
 */
export async function applySyncBootstrap({
  bootstrap,
  projectDir,
  globalConfig,
  sshOk = true,
  checkedSsh = false,
}) {
  if (bootstrap === "seed") {
    const seeded = seedContentHashesFromDisk(projectDir, (rel) =>
      shouldIgnoreRel(rel, globalConfig.ignore),
    );
    console.log(`Seeded ${seeded.count} content hash(es) → ${seeded.path}`);
    return;
  }

  if (bootstrap === "push") {
    if (checkedSsh && !sshOk) {
      console.log("Skipping initial push because SSH check failed. Later: sftp-autosync push");
      return;
    }
    const project = loadProjectConfig(projectDir);
    if (!project) {
      throw new Error(`Missing project config after setup: ${projectDir}`);
    }
    const pool = new SshPool({
      ssh: globalConfig.ssh,
      concurrency: globalConfig.concurrency,
    });
    const visibility = new ProjectVisibility({
      notify: globalConfig.notify.enabled,
      slowMs: globalConfig.notify.slowMs,
      delayMs: 0,
      onSuccess: false,
      onFailure: globalConfig.notify.onFailure,
    });
    console.log("Uploading entire project…");
    try {
      const pushResult = await pushProject({
        project,
        ignore: globalConfig.ignore,
        pool,
        visibility,
        skipUnchanged: false,
      });
      console.log(
        `Push finished: uploaded=${pushResult.uploaded} skipped=${pushResult.skipped} failed=${pushResult.failed}`,
      );
      if (pushResult.failed > 0) process.exitCode = 1;
    } finally {
      await pool.close();
    }
    return;
  }

  console.log("Skipped initial sync. Later: sftp-autosync push");
}

/**
 * @param {SyncBootstrap} fromFlags
 * @param {boolean} interactive
 * @returns {Promise<"seed" | "push" | "skip">}
 */
export async function resolveSyncBootstrap(fromFlags, interactive) {
  if (fromFlags === "seed" || fromFlags === "push" || fromFlags === "skip") {
    return fromFlags;
  }
  if (!interactive) return "skip";

  const alreadySynced = handleCancel(
    await confirm({
      message: "Is this project already fully synced with the remote?",
      active: "Yes — seed hashes only",
      inactive: "No",
      initialValue: false,
    }),
  );
  if (alreadySynced) return "seed";

  const choice = handleCancel(
    await select({
      message: "Initial sync",
      options: [
        {
          value: "push",
          label: "Upload entire project now",
          hint: "then watch for changes",
        },
        {
          value: "skip",
          label: "Do nothing",
          hint: "upload only when files change",
        },
      ],
      initialValue: "push",
    }),
  );
  return choice === "push" ? "push" : "skip";
}
