import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { remoteDirname } from "./router.js";

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
  #closed = false;

  constructor({ ssh, concurrency, spawn = Bun.spawn.bind(Bun) }) {
    this.#ssh = ssh;
    this.#concurrency = Math.max(1, concurrency);
    this.#spawn = spawn;
  }

  identityKey(project) {
    return `${project.username}@${project.host}:${project.port}:${project.privateKeyPath}`;
  }

  async upload(project, localPath, remotePath) {
    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      await this.#run(project, "ssh", [
        ...this.#sshArgs(project),
        this.#target(project),
        "mkdir",
        "-p",
        "--",
        remoteDirname(remotePath),
      ]);
      await this.#run(project, "scp", [
        ...this.#scpArgs(project),
        localPath,
        `${this.#target(project)}:${remotePath}`,
      ]);
    });
  }

  async mkdir(project, remotePath) {
    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      await this.#run(project, "ssh", [
        ...this.#sshArgs(project),
        this.#target(project),
        "mkdir",
        "-p",
        "--",
        remotePath,
      ]);
    });
  }

  async removeFile(project, remotePath) {
    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      await this.#removeFileOnce(project, remotePath);
    });
  }

  async removeDir(project, remotePath) {
    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      await this.#removeDirOnce(project, remotePath);
    });
  }

  /** Recursively delete a remote directory tree (`rm -rf`). */
  async removeTree(project, remotePath) {
    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      await this.#removeTreeOnce(project, remotePath);
    });
  }

  /**
   * Delete a remote path. When kind is unknown, probe with `test -d` so
   * pre-existing directories are not misrouted through `rm -f`.
   * Directory deletes use `rm -rf` so missing child events cannot leave orphans.
   * @param {"file" | "dir" | undefined} kind
   */
  async remove(project, remotePath, kind) {
    if (kind === "dir") return this.removeTree(project, remotePath);
    if (kind === "file") return this.removeFile(project, remotePath);

    return this.#enqueue(project, async () => {
      await this.#ensureMaster(project);
      if (await this.#remoteIsDir(project, remotePath)) {
        await this.#removeTreeOnce(project, remotePath);
      } else {
        await this.#removeFileOnce(project, remotePath);
      }
    });
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
    assertSafeRemoteTreePath(remotePath);
    await this.#run(project, "ssh", [
      ...this.#sshArgs(project),
      this.#target(project),
      "rm",
      "-rf",
      "--",
      remotePath,
    ]);
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

/** Refuse catastrophic recursive deletes. */
export function assertSafeRemoteTreePath(remotePath) {
  if (!remotePath || remotePath === "/") {
    throw new Error(`refusing to rm -rf unsafe remote path: ${remotePath || "(empty)"}`);
  }
}
