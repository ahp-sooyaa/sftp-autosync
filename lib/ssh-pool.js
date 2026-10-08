import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { assertSafeRemoteTreePath } from "./remote-path.js";
import { remoteDirname } from "./router.js";

export { assertSafeRemoteTreePath } from "./remote-path.js";
export { isSafeRemoteTreePath, unsafeRemotePathReason } from "./remote-path.js";

const TRASH_DIR = ".sftp-autosync-trash";
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** ControlMaster / doctor probe identity (includes private key path). */
export function sshPoolIdentityKey(project) {
  return `${project.username}@${project.host}:${project.port}:${project.privateKeyPath}`;
}

/**
 * OpenSSH ControlMaster pool — one multiplexed socket per user@host:port+key.
 * Transfers via scp / ssh (mkdir/rm) using Bun.spawn.
 */
export class SshPool {
  #ssh;
  #concurrency;
  #spawn;
  #clients = new Map();
  #queues = new Map();
  #active = new Map();
  /** @type {Map<string, Promise<void>>} serializes ensureMaster per identity */
  #masterLocks = new Map();
  /** @type {Set<string>} identity:remoteDir paths created this process */
  #createdRemoteDirs = new Set();
  #closed = false;

  constructor({ ssh, concurrency, spawn = Bun.spawn.bind(Bun) }) {
    this.#ssh = ssh;
    this.#concurrency = Math.max(1, concurrency);
    this.#spawn = spawn;
  }

  identityKey(project) {
    return sshPoolIdentityKey(project);
  }

  async upload(project, localPath, remotePath) {
    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      const parent = remoteDirname(remotePath);
      const dirKey = `${this.identityKey(project)}:${parent}`;
      if (!this.#createdRemoteDirs.has(dirKey)) {
        try {
          await this.#run(project, "ssh", [
            ...this.#sshArgs(project),
            this.#target(project),
            "mkdir",
            "-p",
            "--",
            parent,
          ]);
          this.#createdRemoteDirs.add(dirKey);
        } catch (err) {
          this.#createdRemoteDirs.delete(dirKey);
          throw err;
        }
      }
      try {
        await this.#run(project, "scp", [
          ...this.#scpArgs(project),
          localPath,
          `${this.#target(project)}:${remotePath}`,
        ]);
      } catch (err) {
        this.#createdRemoteDirs.delete(dirKey);
        throw err;
      }
    });
  }

  async mkdir(project, remotePath) {
    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      const dirKey = `${this.identityKey(project)}:${remotePath}`;
      if (this.#createdRemoteDirs.has(dirKey)) return;
      await this.#run(project, "ssh", [
        ...this.#sshArgs(project),
        this.#target(project),
        "mkdir",
        "-p",
        "--",
        remotePath,
      ]);
      this.#createdRemoteDirs.add(dirKey);
    });
  }

  /** @returns {Promise<boolean>} */
  async remotePathExists(project, remotePath) {
    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      return this.#remoteExists(project, remotePath);
    });
  }

  /**
   * @returns {Promise<{ status: "missing" | "empty" | "nonempty", count: number, remotePath: string }>}
   */
  async probeRemoteTree(project, remotePath) {
    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      const isDir = await this.#remoteIsDir(project, remotePath);
      if (!isDir) {
        const exists = await this.#remoteExists(project, remotePath);
        if (!exists) return { status: "missing", count: 0, remotePath };
        return { status: "nonempty", count: 1, remotePath };
      }
      const count = await this.#remoteEntryCount(project, remotePath);
      if (count === 0) return { status: "empty", count: 0, remotePath };
      return { status: "nonempty", count, remotePath };
    });
  }

  async removeDir(project, remotePath) {
    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      await this.#removeDirOnce(project, remotePath);
    });
  }

  /**
   * Delete a remote path. When kind is unknown, probe with `test -d` so
   * pre-existing directories are not misrouted through `rm -f`.
   * Directory deletes use `rm -rf` so missing child events cannot leave orphans.
   * @param {"file" | "dir" | undefined} kind
   */
  async remove(project, remotePath, kind) {
    if (kind === "dir") return this.trashTree(project, remotePath);
    if (kind === "file") return this.trashFile(project, remotePath);

    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      if (await this.#remoteIsDir(project, remotePath)) {
        await this.#trashTreeOnce(project, remotePath);
      } else {
        await this.#trashFileOnce(project, remotePath);
      }
    });
  }

  async trashFile(project, remotePath) {
    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      await this.#trashFileOnce(project, remotePath);
    });
  }

  async trashTree(project, remotePath) {
    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      await this.#trashTreeOnce(project, remotePath);
    });
  }

  async removeFile(project, remotePath) {
    return this.trashFile(project, remotePath);
  }

  async removeTree(project, remotePath) {
    return this.trashTree(project, remotePath);
  }

  async #removeFileOnce(project, remotePath) {
    await this.#run(project, "ssh", [
      ...this.#sshArgs(project),
      this.#target(project),
      "rm",
      "-f",
      "--",
      remotePath,
    ]);
  }

  async #removeDirOnce(project, remotePath) {
    try {
      await this.#run(project, "ssh", [
        ...this.#sshArgs(project),
        this.#target(project),
        "rmdir",
        "--",
        remotePath,
      ]);
    } catch (err) {
      // Already gone is success; not-empty / permission / probe errors must surface.
      if (!(await this.#remoteExists(project, remotePath))) return;
      throw err;
    }
  }

  async #removeTreeOnce(project, remotePath) {
    await this.#trashTreeOnce(project, remotePath);
  }

  async #trashFileOnce(project, remotePath) {
    if (!(await this.#remoteExists(project, remotePath))) return;
    const dest = this.#trashDestination(project, remotePath);
    await this.#moveRemoteToTrash(project, remotePath, dest);
  }

  async #trashTreeOnce(project, remotePath) {
    assertSafeRemoteTreePath(remotePath);
    if (!(await this.#remoteExists(project, remotePath))) return;
    const dest = this.#trashDestination(project, remotePath);
    await this.#moveRemoteToTrash(project, remotePath, dest);
  }

  #trashDestination(project, remotePath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const root = project.remotePath.replace(/\/+$/g, "");
    const prefix = `${root}/${TRASH_DIR}/${stamp}`;
    const rel = remotePath.startsWith(`${root}/`)
      ? remotePath.slice(root.length + 1)
      : remotePath.replace(/^\//, "").replace(/\//g, "__");
    return `${prefix}/${rel || basename(remotePath)}`;
  }

  async #moveRemoteToTrash(project, remotePath, destPath) {
    assertSafeRemoteTreePath(remotePath);
    const destParent = remoteDirname(destPath);
    await this.#run(project, "ssh", [
      ...this.#sshArgs(project),
      this.#target(project),
      "mkdir",
      "-p",
      "--",
      destParent,
    ]);
    await this.#run(project, "ssh", [
      ...this.#sshArgs(project),
      this.#target(project),
      "mv",
      "-f",
      "--",
      remotePath,
      destPath,
    ]);
    await this.#pruneTrash(project);
  }

  async #pruneTrash(project) {
    const root = project.remotePath.replace(/\/+$/g, "");
    const trashRoot = `${root}/${TRASH_DIR}`;
    await this.#run(project, "ssh", [
      ...this.#sshArgs(project),
      this.#target(project),
      "sh",
      "-c",
      `if [ -d '${trashRoot.replace(/'/g, "'\\''")}' ]; then find '${trashRoot.replace(/'/g, "'\\''")}' -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true; fi`,
    ]).catch(() => {});
  }

  async #remoteEntryCount(project, remotePath) {
    const quoted = remotePath.replace(/'/g, `'\\''`);
    // `ls` must be the command whose exit code we see. A pipe into `wc` would
    // report success (and a count of 0) when listing fails.
    const result = await this.#runRaw("ssh", [
      ...this.#sshArgs(project),
      this.#target(project),
      "sh",
      "-c",
      `if [ -d '${quoted}' ]; then ls -A '${quoted}'; else exit 2; fi`,
    ]);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      throw new Error(`remote listing failed: ${detail || `exit ${result.exitCode}`}`);
    }
    const lines = (result.stdout || "").split("\n").filter((line) => line.length > 0);
    return lines.length;
  }

  /**
   * @returns {Promise<boolean>}
   * @throws when SSH itself fails (must not be treated as "missing")
   */
  async #remoteIsDir(project, remotePath) {
    return this.#remoteTest(project, ["-d", remotePath]);
  }

  /**
   * @returns {Promise<boolean>}
   * @throws when SSH itself fails (must not be treated as "missing")
   */
  async #remoteExists(project, remotePath) {
    return this.#remoteTest(project, ["-e", remotePath]);
  }

  async #remoteTest(project, testArgs) {
    const runProbe = async () =>
      this.#runRaw("ssh", [...this.#sshArgs(project), this.#target(project), "test", ...testArgs]);

    let result = await runProbe();
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;

    // Non-1 failure is usually a dead master / SSH error — recover and retry once.
    try {
      await this.#runRaw("ssh", [...this.#sshArgs(project), "-O", "exit", this.#target(project)]);
    } catch {
      // ignore
    }
    await this.#ensureMaster(project);
    result = await runProbe();
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;

    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `ssh test ${testArgs.join(" ")} failed: ${detail || `exit ${result.exitCode}`}`,
    );
  }

  /** Wait until all queued and in-flight jobs finish. */
  async drain() {
    for (;;) {
      let busy = false;
      for (const [key, queue] of this.#queues) {
        if (queue.length > 0 || (this.#active.get(key) ?? 0) > 0) {
          busy = true;
          break;
        }
      }
      if (!busy) return;
      await Bun.sleep(10);
    }
  }

  async close() {
    this.#closed = true;
    await this.drain();
    for (const project of this.#clients.values()) {
      try {
        await this.#run(project, "ssh", [
          ...this.#sshArgs(project),
          "-O",
          "exit",
          this.#target(project),
        ]);
      } catch {
        // Master may already be gone.
      }
    }
    this.#clients.clear();
  }

  #target(project) {
    return `${project.username}@${project.host}`;
  }

  #controlPath(project) {
    mkdirSync(this.#ssh.controlDir, { recursive: true });
    // Keep under macOS sun_path limits (~104 bytes).
    const digest = createHash("sha1").update(this.identityKey(project)).digest("hex").slice(0, 16);
    return join(this.#ssh.controlDir, digest);
  }

  #commonOpts(project) {
    return [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `ConnectTimeout=${this.#ssh.connectTimeout}`,
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${this.#controlPath(project)}`,
      "-o",
      `ControlPersist=${this.#ssh.controlPersist}`,
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-i",
      project.privateKeyPath,
      "-p",
      String(project.port),
    ];
  }

  #sshArgs(project) {
    return this.#commonOpts(project);
  }

  #scpArgs(project) {
    // scp uses -P for port and -o for ssh options; -i works the same.
    return [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `ConnectTimeout=${this.#ssh.connectTimeout}`,
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${this.#controlPath(project)}`,
      "-o",
      `ControlPersist=${this.#ssh.controlPersist}`,
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-i",
      project.privateKeyPath,
      "-P",
      String(project.port),
    ];
  }

  async #ensureMaster(project) {
    const key = this.identityKey(project);
    this.#clients.set(key, project);
    return this.#withMasterLock(key, () => this.#ensureMasterUnlocked(project));
  }

  async #withMasterLock(key, fn) {
    const prev = this.#masterLocks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    // Always advance the chain even if the previous opener failed.
    this.#masterLocks.set(
      key,
      prev.catch(() => {}).then(() => gate),
    );
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async #ensureMasterUnlocked(project) {
    const check = await this.#runRaw("ssh", [
      ...this.#sshArgs(project),
      "-O",
      "check",
      this.#target(project),
    ]);
    if (check.exitCode === 0) return;

    // Open a background master connection.
    const open = await this.#runRaw("ssh", [
      ...this.#sshArgs(project),
      "-MNf",
      this.#target(project),
    ]);
    if (open.exitCode !== 0) {
      const detail = (open.stderr || open.stdout || "").trim();
      throw new Error(
        `SSH master failed for ${this.#target(project)}:${project.port}: ${detail || `exit ${open.exitCode}`}`,
      );
    }
  }

  async #enqueue(project, work) {
    if (this.#closed) {
      throw new Error("SshPool is closed");
    }
    const key = this.identityKey(project);
    if (!this.#queues.has(key)) {
      this.#queues.set(key, []);
      this.#active.set(key, 0);
    }

    return new Promise((resolve, reject) => {
      this.#queues.get(key).push({ work, resolve, reject });
      this.#drain(key);
    });
  }

  #drain(key) {
    const queue = this.#queues.get(key);
    if (!queue) return;

    while (this.#active.get(key) < this.#concurrency && queue.length > 0) {
      const job = queue.shift();
      this.#active.set(key, this.#active.get(key) + 1);
      job
        .work()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.#active.set(key, this.#active.get(key) - 1);
          this.#drain(key);
        });
    }
  }

  async #run(project, bin, args) {
    const result = await this.#runRaw(bin, args);
    if (result.exitCode === 0) return result;

    // Drop stale master and retry once.
    try {
      await this.#runRaw("ssh", [...this.#sshArgs(project), "-O", "exit", this.#target(project)]);
    } catch {
      // ignore
    }

    await this.#ensureMaster(project);
    const retry = await this.#runRaw(bin, args);
    if (retry.exitCode === 0) return retry;

    const detail = (retry.stderr || retry.stdout || "").trim();
    throw new Error(`${bin} failed: ${detail || `exit ${retry.exitCode}`}`);
  }

  async #runRaw(bin, args) {
    const proc = this.#spawn([bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Prefer key auth; avoid interactive prompts hanging launchd.
        SSH_ASKPASS_REQUIRE: "never",
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }
}

