import { cancel, confirm, intro, outro, select, text } from "@clack/prompts";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { discoverSshPrivateKeys, handleCancel, isInteractive } from "../cli.js";
import { expandHome, isParkedProject, loadGlobalConfig } from "../config.js";
import { ensureParentDirs } from "../init.js";
import { isLaunchdInstalled } from "../launchd.js";
import { globalConfigPath } from "../paths.js";
import { checkSshConnection, createProjectConfig, ensureGitignore } from "../setup.js";
import { CONFIG_FILE, META_DIR, configPath } from "../visibility.js";
import { ensureInitialized } from "./ensure-init.js";

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
  --force                    Overwrite existing sync-config.json
  --check                    Probe SSH with BatchMode after writing config
  --no-check                 Skip SSH probe (default when non-interactive)
  -h, --help                 Show help
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

  const result = createProjectConfig({
    projectRoot: projectDir,
    host,
    port,
    username,
    privateKeyPath,
    remotePath,
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

  if (doCheck) {
    console.log("Checking SSH…");
    const probe = await checkSshConnection(result.config);
    if (probe.ok) {
      console.log(probe.detail);
    } else {
      console.error(`SSH check failed: ${probe.detail}`);
      process.exitCode = 1;
      if (interactive) {
        outro("Config saved — fix SSH auth, then: sftp-autosync setup --check");
      } else {
        console.log("Config saved; fix SSH auth and re-run with --check");
      }
      return;
    }
  }

  const nextStep = isLaunchdInstalled()
    ? "Done. The launchd agent will sync this project automatically."
    : "Done. Start sync with: sftp-autosync start";

  if (interactive) {
    outro(nextStep);
  } else {
    console.log(isLaunchdInstalled() ? nextStep : "Next: sftp-autosync start");
  }
}
