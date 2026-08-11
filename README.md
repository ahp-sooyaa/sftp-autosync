# SFTP Auto-Sync

Valet-style SFTP auto-sync for macOS. Park a parent folder (default `~/Clickr`); every child project with `.sftp-autosync/sync-config.json` is watched and uploaded over **OpenSSH ControlMaster**.

## Requirements

- [Bun](https://bun.sh)
- OpenSSH client (`ssh`, `scp`) — included on macOS
- SSH key auth (password auth is not supported)

## Quick start

1. Global config parks `~/Clickr` (see `config.json`).

2. In a project under `~/Clickr`, create a local meta folder (keep it out of git):

```bash
mkdir -p .sftp-autosync
cp ~/Personal/sftp-autosync/sync-config.example.json .sftp-autosync/sync-config.json
echo '.sftp-autosync/' >> .gitignore
# edit .sftp-autosync/sync-config.json
```

Example `.sftp-autosync/sync-config.json`:

```json
{
  "host": "example.s1.clickrlabs.com",
  "port": 8288,
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "remotePath": "/home/deploy/public_html/my-project",
  "routes": [
    { "local": "iwov-resources", "remote": "/home/deploy/public_html/iwov-resources" }
  ]
}
```

3. Run in the foreground to verify:

```bash
cd ~/Personal/sftp-autosync
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
  "project": "dbs-foundation-revamp",
  "state": "ok",
  "op": "upload",
  "file": "package.json",
  "remote": "/home/.../package.json",
  "error": null,
  "durationMs": 180,
  "at": "2026-08-11T10:00:00.000Z"
}
```

Follow a project log:

```bash
tail -f ~/Clickr/dbs-foundation-revamp/.sftp-autosync/sync.log
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
my-project/                 -> /home/deploy/public_html/my-project
└── iwov-resources/         -> /home/deploy/public_html/iwov-resources
```

Same host/user/key shares one ControlMaster socket across routes and projects.

## launchd (start at login)

```bash
cd ~/Personal/sftp-autosync
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

- New projects appear after you add `.sftp-autosync/sync-config.json` (parent watch + periodic rescan).
- Connection reuse: `ControlMaster=auto` + `ControlPersist` under `~/Library/Caches/sftp-autosync/cm`.
- Prefer `ssh-agent` for passphrase-protected keys.
