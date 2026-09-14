---
name: sftp-autosync
description: >-
  Set up and upload files with sftp-autosync over SFTP on macOS. Use when the
  user says push to remote, upload via SFTP, sync to the server, or set up
  sftp-autosync for a parked project.
---

# sftp-autosync

CLI for Valet-style SFTP sync on macOS. Projects live under parked parents (default `~/Sites`); each project has `.sftp-autosync/sync-config.json`.

## Rules

- Always pass CLI flags. Never use the interactive TTY menu.
- Prefer **manual** mode for new setup (`--manual`). No automatic watcher deletes.
- Never commit `.sftp-autosync/` (contains host, keys, hashes, logs).
- If launchd is already loaded, use `status` or `restart` — do not run a second `start` watcher.
- On upload failure, read `.sftp-autosync/sync.log` and `status.json`.

## Setup (non-interactive)

One-time machine init:

```bash
sftp-autosync init --no-launchd   # or --launchd if daemon wanted
```

Per project:

```bash
cd ~/Sites/my-project
sftp-autosync setup \
  --host sftp.example.com \
  --username deploy \
  --remote-path /var/www/my-project \
  --private-key ~/.ssh/id_ed25519 \
  --manual \
  --no-check
sftp-autosync restart
```

Switch an existing project to manual without rewriting host/key:

```bash
sftp-autosync setup --manual
sftp-autosync restart
```

## Push to remote

When the user says **push to remote** or **upload changed files**:

```bash
sftp-autosync push --changed
```

Uploads git working-tree changes (staged, unstaged vs HEAD, untracked). Skips deletes and ignored paths.

For named files or folders:

```bash
sftp-autosync push index.html src/
```

For a full project upload (not git-scoped):

```bash
sftp-autosync push
```

Re-upload even when fingerprints match:

```bash
sftp-autosync push --changed --force
```

## Inspect state

```bash
sftp-autosync list
sftp-autosync status
tail -f .sftp-autosync/sync.log
```

## Sync modes

| Mode | Behavior |
| --- | --- |
| `manual` | Upload only with `push`; watcher skipped |
| `auto` | Watch and upload on change (default if `mode` omitted on old configs) |
