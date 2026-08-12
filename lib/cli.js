import { cancel, isCancel } from "@clack/prompts";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Exit cleanly when the user cancels a Clack prompt (Ctrl+C / Escape). */
export function handleCancel(value, message = "Cancelled.") {
  if (isCancel(value)) {
    cancel(message);
    process.exit(0);
  }
  return value;
}

export function printHelp() {
  console.log(`sftp-autosync — Valet-style SFTP auto-sync for macOS

Usage:
  sftp-autosync <command> [options]

Commands:
  init     Create global config, parked parents, optional launchd
  setup    Configure the current (or given) project for sync
  push     Upload files now (whole project or specific paths)
  start    Run the watcher in the foreground
  help     Show this help

Install:
  bun install -g sftp-autosync
  # or: npm install -g sftp-autosync
  # or: brew tap ahp-sooyaa/sftp-autosync && brew install --HEAD sftp-autosync

Examples:
  sftp-autosync init
  sftp-autosync setup
  sftp-autosync setup ~/Sites/my-app --host sftp.example.com --username deploy \\
    --remote-path /var/www/my-app --check
  sftp-autosync push
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
