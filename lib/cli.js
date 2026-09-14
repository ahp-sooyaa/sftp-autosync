import { cancel, intro, isCancel, select } from "./prompts.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Commands shown in the bare `sftp-autosync` TTY menu. */
export const COMMAND_MENU_OPTIONS = [
  { value: "init", label: "init", hint: "global config and parked parents" },
  { value: "setup", label: "setup", hint: "configure this project for sync" },
  { value: "config", label: "config", hint: "view or edit global / project config" },
  { value: "list", label: "list", hint: "parked parents and synced projects" },
  { value: "status", label: "status", hint: "daemon and per-project sync state" },
  { value: "log", label: "log", hint: "tail daemon or project logs" },
  { value: "push", label: "push", hint: "upload files now" },
  { value: "start", label: "start", hint: "run the watcher in the foreground" },
  { value: "restart", label: "restart", hint: "reload the launchd agent" },
  { value: "help", label: "help", hint: "show CLI reference" },
];

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Exit cleanly when the user cancels a prompt (Ctrl+C / Escape). */
export function handleCancel(value, message = "Cancelled.") {
  if (isCancel(value)) {
    cancel(message);
    process.exit(0);
  }
  return value;
}

/** Interactive root menu; returns a command name. */
export async function promptCommand(io) {
  intro("sftp-autosync", io);
  return handleCancel(
    await select(
      {
        message: "Choose a command",
        options: COMMAND_MENU_OPTIONS,
        initialValue: "setup",
      },
      io,
    ),
  );
}

export function printHelp() {
  console.log(`sftp-autosync — Valet-style SFTP auto-sync for macOS

Usage:
  sftp-autosync [command] [options]

  With no command in a terminal, opens an interactive command menu.

Commands:
  init     Create global config, parked parents, optional launchd
  setup    Configure the current (or given) project for sync
  config   View or edit global or project config
  list     List parked parents and synced projects
  status   Show launchd and per-project sync status
  log      Tail daemon or project logs
  push     Upload files now (whole project, git-changed, or specific paths)
  start    Run the watcher in the foreground
  restart  Reload the launchd agent
  help     Show this help

Install:
  bun install -g sftp-autosync
  # or: npm install -g sftp-autosync
  # or: brew tap ahp-sooyaa/sftp-autosync && brew install --HEAD sftp-autosync

Examples:
  sftp-autosync
  sftp-autosync init
  sftp-autosync setup
  sftp-autosync config --edit
  sftp-autosync list
  sftp-autosync status
  sftp-autosync log
  sftp-autosync restart
  sftp-autosync setup ~/Sites/my-app --host sftp.example.com --username deploy \\
    --remote-path /var/www/my-app --check
  sftp-autosync push
  sftp-autosync push --changed
  sftp-autosync push package.json src/
  sftp-autosync start

Global config: ~/Library/Application Support/sftp-autosync/config.json
`);
}

/** Common private key paths under ~/.ssh that exist on disk. */
export function discoverSshPrivateKeys() {
  const sshDir = join(homedir(), ".ssh");
  if (!existsSync(sshDir)) return [];

  const preferred = [
    "id_ed25519",
    "id_ecdsa",
    "id_rsa",
    "id_ed25519_sk",
    "id_ecdsa_sk",
    "id_rsa_sk",
  ];
  const found = [];
  const seen = new Set();

  const pushKey = (name) => {
    if (seen.has(name)) return;
    const absolute = join(sshDir, name);
    try {
      if (!statSync(absolute).isFile()) return;
    } catch {
      return;
    }
    seen.add(name);
    found.push({ absolute, display: `~/.ssh/${name}` });
  };

  for (const name of preferred) pushKey(name);

  try {
    for (const name of readdirSync(sshDir)) {
      if (name.endsWith(".pub") || name.startsWith(".")) continue;
      if (["config", "known_hosts", "authorized_keys", "known_hosts.old"].includes(name)) {
        continue;
      }
      pushKey(name);
    }
  } catch {
    // ignore unreadable .ssh
  }

  return found;
}

export function parseParents(value) {
  return String(value ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}
