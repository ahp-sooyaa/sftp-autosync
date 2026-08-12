# SFTP Auto-Sync

Valet-style SFTP auto-sync for macOS. Park a parent folder (default `~/Sites`); every child project with `.sftp-autosync/sync-config.json` is watched and uploaded over **OpenSSH ControlMaster**.

## Requirements

- [Bun](https://bun.sh)
- OpenSSH client (`ssh`, `scp`) — included on macOS
- SSH key auth (password auth is not supported)

## Quick start

1. Global config parks `~/Sites` (copy `config.example.json` → `config.json`).

2. In a project under `~/Sites`, create a local meta folder (keep it out of git):

```bash
mkdir -p .sftp-autosync
cp /path/to/sftp-autosync/sync-config.example.json .sftp-autosync/sync-config.json
echo '.sftp-autosync/' >> .gitignore
# edit .sftp-autosync/sync-config.json
```

Example `.sftp-autosync/sync-config.json`:

```json
{
  "host": "sftp.example.com",
  "port": 22,
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "remotePath": "/var/www/my-project",
  "routes": [
    { "local": "shared-assets", "remote": "/var/www/shared-assets" }
  ]
}
```

3. Run in the foreground to verify:

```bash
cd /path/to/sftp-autosync
bun sync.js
```

You should see `[watch] add project ...` for each project that has `.sftp-autosync/sync-config.json`.

## Per-project visibility

Each project keeps local state under `.sftp-autosync/` (never uploaded, gitignore it):

| File | Purpose |
| --- | --- |
| `sync-config.json` | Host, key, remote paths (secrets — do not commit) |
| `sync.log` | Append-only history (`uploading` / `ok` / `error`) |
| `status.json` | Latest op snapshot for agents / scripts |

Example `status.json`:

```json
{
  "project": "my-project",
  "state": "ok",
  "op": "upload",
  "file": "package.json",
  "remote": "/var/www/my-project/package.json",
  "error": null,
  "durationMs": 180,
  "at": "2026-08-11T10:00:00.000Z"
}
```

Follow a project log:

```bash
tail -f ~/Sites/my-project/.sftp-autosync/sync.log
```

### macOS notifications

Configured in global `config.json` → `notify`:

- **Failure** → always notify (default)
- **Slow** → notify if an op is still running after `slowMs` (default 2000), then notify again when it finishes if it was slow
- **Fast success** → off by default (`onSuccess: false`)
- **`delayMs`** → artificial wait before each transfer (default `0`). Set to e.g. `3000` to demo slow notifications; set back to `0` for normal use.

## Split folder routing

Longest matching `routes[].local` prefix wins; everything else maps under `remotePath`.

```
my-project/                 -> /var/www/my-project
└── shared-assets/          -> /var/www/shared-assets
```

Same host/user/key shares one ControlMaster socket across routes and projects.

## launchd (start at login)

```bash
cd /path/to/sftp-autosync
bun launchd/install.js          # install + load
bun launchd/install.js --uninstall
```

Daemon stdout/stderr (startup / watch events):

- `~/Library/Logs/sftp-autosync/out.log`
- `~/Library/Logs/sftp-autosync/err.log`

```bash
tail -f ~/Library/Logs/sftp-autosync/out.log
launchctl list | grep sftp-autosync
```

Per-file transfer detail still lives in each project’s `.sftp-autosync/sync.log`.

## Ignore rules

Default ignores: `.git`, `node_modules`, `.DS_Store`, `.sftp-autosync`, `*.tmp`, `*.swp`.

## Notes

- Uploads skip when file bytes match the last *successful* upload fingerprint (SHA-256). Same-content rewrites after a sync no longer hit the remote.
- New projects appear after you add `.sftp-autosync/sync-config.json` (parent watch + periodic rescan).
- Connection reuse: `ControlMaster=auto` + `ControlPersist` under `~/Library/Caches/sftp-autosync/cm`.
- Prefer `ssh-agent` for passphrase-protected keys.
