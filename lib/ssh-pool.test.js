import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeRemoteTreePath, SshPool } from "./ssh-pool.js";

const project = {
  username: "deploy",
  host: "example.test",
  port: 22,
  privateKeyPath: "/tmp/id_test",
};

function fakeProc({ exitCode = 0, stdout = "", stderr = "" } = {}) {
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stderr));
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
  };
}

function createPool(handler, { concurrency = 1 } = {}) {
  const controlDir = mkdtempSync(join(tmpdir(), "sftp-autosync-test-"));
  const calls = [];
  const pool = new SshPool({
    ssh: {
      controlPersist: "1m",
      connectTimeout: 5,
      controlDir,
    },
    concurrency,
    spawn: (argv) => {
      calls.push(argv);
      return fakeProc(handler(argv, calls.length));
    },
  });
  return { pool, calls, controlDir };
}

function remoteCmd(argv) {
  return argv.slice(argv.indexOf("deploy@example.test") + 1);
}

describe("SshPool.removeDir", () => {
  test("throws when remote directory still exists after rmdir failure", async () => {
    const { pool, controlDir } = createPool((argv) => {
      const cmd = remoteCmd(argv);
      if (cmd[0] === "-O" && cmd[1] === "check") return { exitCode: 0 };
      if (cmd[0] === "rmdir") return { exitCode: 1, stderr: "Directory not empty" };
      if (cmd[0] === "-O" && cmd[1] === "exit") return { exitCode: 0 };
      if (cmd[0] === "test" && cmd[1] === "-e") return { exitCode: 0 };
      return { exitCode: 0 };
    });

    try {
      await expect(pool.removeDir(project, "/home/deploy/app/assets")).rejects.toThrow(
        /rmdir failed|Directory not empty/,
      );
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
    }
  });

  test("succeeds when rmdir fails but remote path is already gone", async () => {
    const { pool, controlDir } = createPool((argv) => {
      const cmd = remoteCmd(argv);
      if (cmd[0] === "-O" && cmd[1] === "check") return { exitCode: 0 };
      if (cmd[0] === "rmdir") return { exitCode: 1, stderr: "No such file or directory" };
      if (cmd[0] === "-O" && cmd[1] === "exit") return { exitCode: 0 };
      if (cmd[0] === "test" && cmd[1] === "-e") return { exitCode: 1 };
      return { exitCode: 0 };
    });

    try {
      await pool.removeDir(project, "/home/deploy/app/gone");
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
    }
  });

  test("does not treat ssh probe errors as missing after rmdir failure", async () => {
    const { pool, controlDir } = createPool((argv) => {
      const cmd = remoteCmd(argv);
      if (cmd[0] === "-O" && cmd[1] === "check") return { exitCode: 0 };
      if (cmd[0] === "rmdir") return { exitCode: 1, stderr: "Directory not empty" };
      if (cmd[0] === "-O" && cmd[1] === "exit") return { exitCode: 0 };
      if (cmd[0] === "test" && cmd[1] === "-e") {
        return { exitCode: 255, stderr: "ssh: connection refused" };
      }
      return { exitCode: 0 };
    });

    try {
      await expect(pool.removeDir(project, "/home/deploy/app/assets")).rejects.toThrow(
        /ssh test|connection refused|Directory not empty/,
      );
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
    }
  });
});

describe("SshPool.remove / removeTree", () => {
  test("probes remote type when kind is unknown and uses rm -rf for directories", async () => {
    const { pool, calls, controlDir } = createPool((argv) => {
      const cmd = remoteCmd(argv);
      if (cmd[0] === "-O" && cmd[1] === "check") return { exitCode: 0 };
      if (cmd[0] === "test" && cmd[1] === "-d") return { exitCode: 0 };
      if (cmd[0] === "rm" && cmd[1] === "-rf") return { exitCode: 0 };
      return { exitCode: 0 };
    });

    try {
      await pool.remove(project, "/home/deploy/app/assets", undefined);
      const cmds = calls.map(remoteCmd);
      expect(cmds.some((cmd) => cmd[0] === "test" && cmd[1] === "-d")).toBe(true);
      expect(cmds.some((cmd) => cmd[0] === "rm" && cmd[1] === "-rf")).toBe(true);
      expect(cmds.some((cmd) => cmd[0] === "rm" && cmd[1] === "-f")).toBe(false);
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
    }
  });

  test("uses rm -f when kind is file without probing", async () => {
    const { pool, calls, controlDir } = createPool((argv) => {
      const cmd = remoteCmd(argv);
      if (cmd[0] === "-O" && cmd[1] === "check") return { exitCode: 0 };
      if (cmd[0] === "rm") return { exitCode: 0 };
      return { exitCode: 0 };
    });

    try {
      await pool.remove(project, "/home/deploy/app/file.txt", "file");
      const cmds = calls.map(remoteCmd);
      expect(cmds.some((cmd) => cmd[0] === "test")).toBe(false);
      expect(cmds.some((cmd) => cmd[0] === "rm" && cmd[1] === "-f")).toBe(true);
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
    }
  });

  test("removeTree uses rm -rf", async () => {
    const { pool, calls, controlDir } = createPool((argv) => {
      const cmd = remoteCmd(argv);
      if (cmd[0] === "-O" && cmd[1] === "check") return { exitCode: 0 };
      if (cmd[0] === "rm" && cmd[1] === "-rf") return { exitCode: 0 };
      return { exitCode: 0 };
    });

    try {
      await pool.removeTree(project, "/home/deploy/app/assets");
      expect(calls.map(remoteCmd).some((cmd) => cmd[0] === "rm" && cmd[1] === "-rf")).toBe(true);
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
    }
  });
});

describe("assertSafeRemoteTreePath", () => {
  test("rejects root and empty paths", () => {
    expect(() => assertSafeRemoteTreePath("/")).toThrow(/unsafe/);
    expect(() => assertSafeRemoteTreePath("")).toThrow(/unsafe/);
  });
});

describe("SshPool.ensureMaster", () => {
  test("serializes concurrent cold master opens for the same identity", async () => {
    let masterUp = false;
    let opens = 0;
    const { pool, controlDir } = createPool(
      (argv) => {
        // ControlMaster flags appear before user@host.
        if (argv.includes("-O") && argv.includes("check")) {
          return { exitCode: masterUp ? 0 : 1 };
        }
        if (argv.includes("-MNf")) {
          opens += 1;
          masterUp = true;
          return { exitCode: 0 };
        }
        const cmd = remoteCmd(argv);
        if (cmd[0] === "mkdir") return { exitCode: 0 };
        return { exitCode: 0 };
      },
      { concurrency: 3 },
    );

    try {
      await Promise.all([
        pool.mkdir(project, "/home/deploy/a"),
        pool.mkdir(project, "/home/deploy/b"),
        pool.mkdir(project, "/home/deploy/c"),
      ]);
      expect(opens).toBe(1);
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
    }
  });
});

describe("SshPool.drain", () => {
  test("waits for in-flight jobs before resolving", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let started = false;
    const controlDir = mkdtempSync(join(tmpdir(), "sftp-autosync-drain-"));

    const pool = new SshPool({
      ssh: {
        controlPersist: "1m",
        connectTimeout: 5,
        controlDir,
      },
      concurrency: 1,
      spawn: (argv) => {
        const cmd = remoteCmd(argv);
        if (cmd[0] === "-O" && cmd[1] === "check") return fakeProc({ exitCode: 0 });
        if (cmd[0] === "mkdir") {
          started = true;
          return {
            stdout: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            stderr: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            exited: gate.then(() => 0),
          };
        }
        return fakeProc({ exitCode: 0 });
      },
    });

    try {
      const job = pool.mkdir(project, "/home/deploy/x");
      await Bun.sleep(20);
      expect(started).toBe(true);

      let drained = false;
      const draining = pool.drain().then(() => {
        drained = true;
      });
      await Bun.sleep(20);
      expect(drained).toBe(false);

      release();
      await job;
      await draining;
      expect(drained).toBe(true);
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
    }
  });
});
