# SFTP Auto-Sync

Valet-style SFTP auto-sync for macOS. Park a parent folder (default `~/Sites`); every child project with `.sftp-autosync/sync-config.json` is watched and uploaded over **OpenSSH ControlMaster**.

## Requirements

- [Bun](https://bun.sh)
- OpenSSH client (`ssh`, `scp`) — included on macOS
- SSH key auth (password auth is not supported)

## Quick start

```bash
bun install -g sftp-autosync
# or: npm install -g sftp-autosync
# or: brew tap ahp-sooyaa/sftp-autosync && brew install --HEAD sftp-autosync

sftp-autosync              # interactive command menu (in a terminal)
sftp-autosync init         # interactive: global config, parents, optional launchd
cd ~/Sites/my-project
sftp-autosync setup        # interactive prompts (arrow keys to select)
sftp-autosync push         # optional: upload whole project (or paths) now
sftp-autosync start        # foreground watcher (or use launchd from init)
```

If you run `setup` before `init`, the CLI offers to run `init` first.

During interactive `setup`, you are asked whether the project is already synced with the remote:

- **Yes** → seed local content hashes (no upload; trust remote already matches)
- **No** → choose full upload now, or skip and upload only when files change

Non-interactive defaults to skip (`--no-push`). Use `--already-synced` or `--push` to opt in.

Global config lives at:

`~/Library/Application Support/sftp-autosync/config.json`

`setup` writes `.sftp-autosync/sync-config.json`, adds `.sftp-autosync/` to `.gitignore`, and can probe SSH.

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

You should see `[watch] add project ...` for each project that has `.sftp-autosync/sync-config.json`.

### CLI reference

```bash
sftp-autosync                                      # interactive menu (TTY)
sftp-autosync init [--parents ~/Sites] [--force] [--launchd|--no-launchd]
sftp-autosync setup [projectDir] [--host …] [--username …] [--remote-path …] \
  [--private-key ~/.ssh/id_ed25519] [--port 22] [--force] [--check|--no-check] \
  [--already-synced|--push|--no-push]
sftp-autosync config [--global | --project [dir]] [--edit | --path]
sftp-autosync list
sftp-autosync status [projectDir]
sftp-autosync log [--err | --project [dir]] [--path] [--no-follow]
sftp-autosync push [projectDir] [paths…] [--force]
sftp-autosync start
sftp-autosync restart
```

In a terminal, values are gathered with interactive prompts (text + arrow-key selects). Flags skip individual questions. Non-interactive `setup` requires `--host`, `--username`, and `--remote-path`.

`config` prints global or project JSON (project if cwd has `.sftp-autosync/sync-config.json`, else global). Use `--edit` to open in `$EDITOR`. After editing global config, run `restart` so the daemon reloads.

`list` shows parked parents and synced projects. `status` shows launchd and per-project `status.json`. `log` tails daemon or project logs (default: follow daemon stdout).

`push` uploads the whole project when no paths are given, or only the listed files/folders. Fingerprints are updated under `.sftp-autosync/content-hashes.json`.
> Note: bare `bun init` is Bun’s own package scaffolder — use `sftp-autosync init`.

## Per-project visibility

Each project keeps local state under `.sftp-autosync/` (never uploaded, gitignore it):

| File | Purpose |
| --- | --- |
| `sync-config.json` | Host, key, remote paths (secrets — do not commit) |
| `content-hashes.json` | SHA-256 fingerprints after successful upload / seed |
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

Configured in global config → `notify`:

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
sftp-autosync init --launchd    # or answer Yes during interactive init
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

- Default `debounceMs` is `1000` (coalesce rapid editor saves).
- Uploads skip when file bytes match a stored fingerprint (after a successful upload, `push`, or `--already-synced` seed). Same-content IDE rewrites no longer hit the remote, including after daemon restart.
- New projects appear after you add `.sftp-autosync/sync-config.json` (parent watch + periodic rescan).
- Connection reuse: `ControlMaster=auto` + `ControlPersist` under `~/Library/Caches/sftp-autosync/cm`.
- Prefer `ssh-agent` for passphrase-protected keys.

## Development

Clone and run from the repo:

```bash
git clone git@github.com:ahp-sooyaa/sftp-autosync.git
cd sftp-autosync
bun install
bun run init
bun run setup
bun test
```

Git-based global install (no npm publish):

```bash
bun install -g github:ahp-sooyaa/sftp-autosync
```

## Homebrew

Tap and install HEAD (until a stable brew release is published):

```bash
brew tap ahp-sooyaa/sftp-autosync https://github.com/ahp-sooyaa/homebrew-sftp-autosync
brew install --HEAD sftp-autosync
```

Or install the formula directly from a checkout:

```bash
brew install --HEAD --formula Formula/sftp-autosync.rb
```

After `v0.2.0` is tagged on GitHub, the tap formula can pin a versioned tarball with `sha256`.
