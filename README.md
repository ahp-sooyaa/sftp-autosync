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

During interactive `setup`, choose **Manual** (default) or **Autosync**:

- **Manual** — upload only with `sftp-autosync push` (one file, several files, or a folder). The watcher does not run; no automatic remote deletes.
- **Autosync** — watch and upload on change (like today’s launchd daemon).

You are also asked whether the project is already synced with the remote:

- **Yes** → seed local content hashes (no upload; trust remote already matches)
- **No** → choose full upload now, or skip and upload later with `push`

Non-interactive setup defaults to **manual** mode and skip initial sync (`--no-push`). Use `--autosync`, `--already-synced`, or `--push` to opt in.

**Switch an existing project to manual** without rewriting host/key:

```bash
cd ~/Sites/my-project
sftp-autosync setup --manual
sftp-autosync restart
```

Existing projects without a `mode` field keep **autosync** behavior until you change them.

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
  "mode": "manual",
  "routes": [
    { "local": "shared-assets", "remote": "/var/www/shared-assets" }
  ]
}
```

You should see `[watch] add project ...` for each **autosync** project. Manual projects log `[watch] skip … (manual — sftp-autosync push)`.

### Manual upload (`push`)

Use `push` like an SFTP extension upload shortcut — from the project directory:

```bash
sftp-autosync push                    # whole project
sftp-autosync push --changed          # git working-tree changes only
sftp-autosync push index.html         # one file
sftp-autosync push a.css b.js src/    # several files and a folder
```

`--changed` uploads files that differ from `HEAD` (staged or unstaged) plus untracked files that are not gitignored. Deletes are not pushed. Requires a git repo in the project directory.

Works for both manual and autosync projects. Manual mode is the safe default when you want to avoid idle watcher deletes on production remotes.

### Cursor agent skill

Install the bundled skill so agents know how to set up and push without the interactive menu:

```bash
cp -R skills/sftp-autosync ~/.cursor/skills/
```

After a global install (`bun install -g sftp-autosync`), copy from the package directory instead:

```bash
cp -R "$(dirname "$(which sftp-autosync)")/../lib/node_modules/sftp-autosync/skills/sftp-autosync" ~/.cursor/skills/
# or from a git clone: cp -R /path/to/sftp-autosync/skills/sftp-autosync ~/.cursor/skills/
```

Then say **push to remote** in Cursor — the agent should run `sftp-autosync push --changed`.

### VS Code / Cursor tasks (keyboard shortcut)

Copy the sample tasks into a parked project workspace:

```bash
mkdir -p ~/Sites/my-project/.vscode
cp examples/vscode/tasks.json ~/Sites/my-project/.vscode/tasks.json
```

In Cursor: **Keyboard Shortcuts** → search **Tasks: Run Task** → bind a key (e.g. `cmd+shift+u`) → choose **SFTP: Push Current File** or **SFTP: Push Git Changed**.

This is the supported stand-in for a custom **Commit & Push** pill — Cursor does not expose a public API to add buttons next to the built-in Git controls.

### CLI reference

```bash
sftp-autosync                                      # interactive menu (TTY)
sftp-autosync init [--parents ~/Sites] [--force] [--launchd|--no-launchd]
sftp-autosync setup [projectDir] [--host …] [--username …] [--remote-path …] \
  [--private-key ~/.ssh/id_ed25519] [--port 22] [--manual|--autosync] [--force] \
  [--check|--no-check] [--already-synced|--push|--no-push]
sftp-autosync config [--global | --project [dir]] [--edit | --path]
sftp-autosync list
sftp-autosync status [projectDir]
sftp-autosync log [--err | --project [dir]] [--path] [--no-follow]
sftp-autosync push [projectDir] [paths…] [--changed] [--force]
sftp-autosync start
sftp-autosync restart
```

In a terminal, values are gathered with interactive prompts (text + arrow-key selects). Flags skip individual questions. Non-interactive `setup` requires `--host`, `--username`, and `--remote-path`.

`config` prints global or project JSON (project if cwd has `.sftp-autosync/sync-config.json`, else global). Use `--edit` to open in `$EDITOR`. After editing global config, run `restart` so the daemon reloads.

`list` shows parked parents and synced projects. `status` shows launchd and per-project `status.json`. `log` tails daemon or project logs (default: follow daemon stdout).

`push` uploads the whole project when no paths are given, only git-changed files with `--changed`, or only the listed files/folders. Fingerprints are updated under `.sftp-autosync/content-hashes.json`.
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

### Local OpenSSH test sandbox

Use the Docker sandbox to test uploads and deletes without touching your work FileZilla host. The container runs a real OpenSSH server (`ssh`, `scp`, `rm`, and SFTP) on `127.0.0.1:2222`, with remote files mirrored on disk under `e2e/remotes/`.

Two sibling parked projects are configured for isolation testing:

| Project | Local | Remote on disk |
| --- | --- | --- |
| `demo` | `e2e/park/demo/` | `e2e/remotes/demo/` |
| `other` | `e2e/park/other/` | `e2e/remotes/other/` |

**Important:** The launchd daemon is machine-wide. Unload it before testing so work projects are not synced:

```bash
launchctl unload ~/Library/LaunchAgents/com.sftp-autosync.plist
```

Start the sandbox:

```bash
bun run e2e:up          # generate keys, write isolated configs, start Docker
bun run e2e:start       # foreground watcher (uses e2e/config.json only)
bun run e2e:isolate     # automated check: demo upload/delete does not touch other/
```

Edit files under `e2e/park/demo/` and inspect the remote:

```bash
ls e2e/remotes/demo
ls e2e/remotes/other    # should stay unchanged when only demo edits
tail -f e2e/park/demo/.sftp-autosync/sync.log
```

To verify a “delete ok” notification: check `sync.log` for `deleting` / `ok delete`, then confirm whether the file is gone in `e2e/remotes/demo/`. A successful `rm -f` also returns 0 when the path was already missing.

To reproduce Cursor-agent cross-project isolation: open `e2e/park/demo` as a workspace, let the agent edit files, and confirm `e2e/remotes/other/` (and `other/.sftp-autosync/sync.log`) stay untouched.

Stop the sandbox:

```bash
bun run e2e:down
```

Reload launchd when you are done testing:

```bash
sftp-autosync init --launchd
# or: sftp-autosync restart
```

Optional: connect with FileZilla using `sftp://deploy@127.0.0.1:2222`, key `e2e/keys/id_ed25519`, remote path `/home/deploy/sites/demo` or `/home/deploy/sites/other` (same files as `e2e/remotes/demo/` and `e2e/remotes/other/` on disk).

The sandbox uses its own global config (`e2e/config.json`) and SSH control socket dir (`e2e/.cm/`). It never reads or writes `~/Library/Application Support/sftp-autosync/config.json`.

### Cross-project isolation and remote collisions

Each parked project gets its own file watcher and maps local paths only through its own `remotePath` / `routes`. Edits in one project should not upload or delete files in another project's remote tree.

If two projects are misconfigured with the same or overlapping remote paths on the same host, the daemon logs a warning at startup:

```text
[config] remote target collision: demo and other both map to deploy@127.0.0.1:2222:/sites/shared
```

Fix by giving each project a distinct `remotePath` in `.sftp-autosync/sync-config.json`.

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

After `v0.3.0` is tagged on GitHub, the tap formula can pin a versioned tarball with `sha256`.
