import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPendingOps, pendingPath } from "./pending.js";
import { pushProject } from "./push.js";
import { ProjectVisibility } from "./visibility.js";
import { ProjectWatcher } from "./watcher.js";

describe("pushProject pending queue", () => {
  test("failed upload writes pending.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-push-retry-"));
    try {
      mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
      writeFileSync(join(root, "index.html"), "hello\n");
      writeFileSync(
        join(root, ".sftp-autosync", "sync-config.json"),
        JSON.stringify({
          host: "127.0.0.1",
          port: 22,
          username: "deploy",
          privateKeyPath: "~/.ssh/id_ed25519",
          remotePath: "/var/www/demo",
        }),
      );

      const pool = {
        identityKey: () => "id",
        async upload() {
          throw new Error("scp failed");
        },
        async mkdir() {},
      };

      const project = {
        name: "demo",
        root,
        host: "127.0.0.1",
        port: 22,
        username: "deploy",
        privateKeyPath: "~/.ssh/id_ed25519",
        remotePath: "/var/www/demo",
        routes: [],
      };

      const result = await pushProject({
        project,
        ignore: [".sftp-autosync"],
        pool,
        paths: ["index.html"],
        visibility: new ProjectVisibility({ notify: false }),
        skipUnchanged: false,
      });

      expect(result.failed).toBe(1);
      const pending = JSON.parse(readFileSync(pendingPath(root), "utf8"));
      expect(pending.ops).toHaveLength(1);
      expect(pending.ops[0].file).toBe("index.html");
      expect(pending.ops[0].lastError).toBe("scp failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("push failure wakes running daemon to drain pending retries", async () => {
    const park = mkdtempSync(join(tmpdir(), "sftp-push-drain-"));
    const keyPath = join(park, "id_test");
    writeFileSync(keyPath, "fake-key\n");
    const projectRoot = join(park, "demo");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, ".sftp-autosync"), { recursive: true });
    writeFileSync(join(projectRoot, "index.html"), "hello\n");
    writeFileSync(
      join(projectRoot, ".sftp-autosync", "sync-config.json"),
      JSON.stringify({
        host: "127.0.0.1",
        port: 2222,
        username: "deploy",
        privateKeyPath: keyPath,
        remotePath: "/remote/demo",
        mode: "auto",
      }),
    );

    const daemonPool = {
      uploadAttempts: 0,
      identityKey(project) {
        return `${project.username}@${project.host}:${project.port}:${project.privateKeyPath}`;
      },
      async upload() {
        daemonPool.uploadAttempts += 1;
      },
      async mkdir() {},
      async remove() {},
      async removeTree() {},
      async close() {},
    };

    const pushPool = {
      identityKey: () => "id",
      async upload() {
        throw new Error("scp failed");
      },
      async mkdir() {},
    };

    const project = {
      name: "demo",
      root: projectRoot,
      host: "127.0.0.1",
      port: 2222,
      username: "deploy",
      privateKeyPath: keyPath,
      remotePath: "/remote/demo",
      routes: [],
      mode: "auto",
    };

    const watcher = new ProjectWatcher(
      {
        parents: [park],
        ignore: [".git", "node_modules", ".DS_Store", ".sftp-autosync", "*.tmp", "*.swp"],
        debounceMs: 50,
        rescanMs: 60_000,
        notify: { enabled: false, slowMs: 0, delayMs: 0, onSuccess: false, onFailure: false },
      },
      daemonPool,
    );
    watcher.start();

    try {
      const result = await pushProject({
        project,
        ignore: [".sftp-autosync"],
        pool: pushPool,
        paths: ["index.html"],
        visibility: new ProjectVisibility({ notify: false }),
        skipUnchanged: false,
      });
      expect(result.failed).toBe(1);
      expect(loadPendingOps(projectRoot)).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 1100));
      await watcher.stop();

      expect(daemonPool.uploadAttempts).toBe(1);
      expect(loadPendingOps(projectRoot)).toHaveLength(0);
    } finally {
      rmSync(park, { recursive: true, force: true });
    }
  });
});
