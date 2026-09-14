import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSshConnection, createProjectConfig, ensureGitignore, patchProjectMode } from "./setup.js";

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "sftp-autosync-setup-"));
  mkdirSync(root, { recursive: true });
  return root;
}

describe("createProjectConfig", () => {
  test("writes sync-config.json under .sftp-autosync", () => {
    const root = tempProject();
    try {
      const result = createProjectConfig({
        projectRoot: root,
        host: "sftp.example.com",
        username: "deploy",
        privateKeyPath: "~/.ssh/id_ed25519",
        remotePath: "/var/www/app",
      });

      expect(result.created).toBe(true);
      expect(existsSync(join(root, ".sftp-autosync", "sync-config.json"))).toBe(true);
      const config = JSON.parse(readFileSync(result.path, "utf8"));
      expect(config).toEqual({
        host: "sftp.example.com",
        port: 22,
        username: "deploy",
        privateKeyPath: "~/.ssh/id_ed25519",
        remotePath: "/var/www/app",
        mode: "manual",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite without force", () => {
    const root = tempProject();
    try {
      createProjectConfig({
        projectRoot: root,
        host: "a.example.com",
        username: "deploy",
        privateKeyPath: "~/.ssh/id_ed25519",
        remotePath: "/var/www/a",
      });
      expect(() =>
        createProjectConfig({
          projectRoot: root,
          host: "b.example.com",
          username: "deploy",
          privateKeyPath: "~/.ssh/id_ed25519",
          remotePath: "/var/www/b",
        }),
      ).toThrow(/already exists/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("overwrites when force is true", () => {
    const root = tempProject();
    try {
      createProjectConfig({
        projectRoot: root,
        host: "a.example.com",
        username: "deploy",
        privateKeyPath: "~/.ssh/id_ed25519",
        remotePath: "/var/www/a",
      });
      createProjectConfig({
        projectRoot: root,
        host: "b.example.com",
        port: 2222,
        username: "deploy",
        privateKeyPath: "~/.ssh/id_ed25519",
        remotePath: "/var/www/b",
        force: true,
      });
      const config = JSON.parse(
        readFileSync(join(root, ".sftp-autosync", "sync-config.json"), "utf8"),
      );
      expect(config.host).toBe("b.example.com");
      expect(config.port).toBe(2222);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves routes when overwriting with force", () => {
    const root = tempProject();
    try {
      mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
      writeFileSync(
        join(root, ".sftp-autosync", "sync-config.json"),
        JSON.stringify({
          host: "old.example.com",
          port: 22,
          username: "deploy",
          privateKeyPath: "~/.ssh/id_ed25519",
          remotePath: "/var/www/a",
          routes: [{ local: "shared-assets", remote: "/var/www/shared-assets" }],
        }),
      );

      createProjectConfig({
        projectRoot: root,
        host: "new.example.com",
        username: "deploy",
        privateKeyPath: "~/.ssh/id_ed25519",
        remotePath: "/var/www/b",
        force: true,
      });

      const config = JSON.parse(
        readFileSync(join(root, ".sftp-autosync", "sync-config.json"), "utf8"),
      );
      expect(config.host).toBe("new.example.com");
      expect(config.routes).toEqual([{ local: "shared-assets", remote: "/var/www/shared-assets" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("patchProjectMode", () => {
  test("updates mode on an existing config", () => {
    const root = tempProject();
    try {
      createProjectConfig({
        projectRoot: root,
        host: "sftp.example.com",
        username: "deploy",
        privateKeyPath: "~/.ssh/id_ed25519",
        remotePath: "/var/www/app",
        mode: "auto",
      });
      const result = patchProjectMode(root, "manual");
      expect(result.mode).toBe("manual");
      const config = JSON.parse(
        readFileSync(join(root, ".sftp-autosync", "sync-config.json"), "utf8"),
      );
      expect(config.mode).toBe("manual");
      expect(config.host).toBe("sftp.example.com");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ensureGitignore", () => {
  test("creates .gitignore with meta entry", () => {
    const root = tempProject();
    try {
      const result = ensureGitignore(root);
      expect(result.updated).toBe(true);
      expect(readFileSync(result.path, "utf8")).toContain(".sftp-autosync/\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is idempotent when entry already present", () => {
    const root = tempProject();
    try {
      writeFileSync(join(root, ".gitignore"), "node_modules/\n.sftp-autosync/\n");
      const result = ensureGitignore(root);
      expect(result.updated).toBe(false);
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(
        "node_modules/\n.sftp-autosync/\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkSshConnection", () => {
  test("reports ok when ssh exits 0", async () => {
    const probe = await checkSshConnection(
      {
        host: "example.test",
        username: "deploy",
        privateKeyPath: "/tmp/id",
        port: 22,
      },
      {
        spawn: () => ({
          stdout: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          stderr: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          exited: Promise.resolve(0),
        }),
      },
    );
    expect(probe.ok).toBe(true);
  });

  test("reports failure detail from stderr", async () => {
    const probe = await checkSshConnection(
      {
        host: "example.test",
        username: "deploy",
        privateKeyPath: "/tmp/id",
      },
      {
        spawn: () => ({
          stdout: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          stderr: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("Permission denied"));
              c.close();
            },
          }),
          exited: Promise.resolve(255),
        }),
      },
    );
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("Permission denied");
  });
});
