import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { COMMAND_MENU_OPTIONS, parseParents, promptCommand } from "./cli.js";
import { createCaptureStdout } from "./prompts.js";
import { parseInitArgs } from "./commands/init.js";
import { parseSetupArgs } from "./commands/setup.js";

function createFakeStdin() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (mode) => {
    stdin.isRaw = mode;
  };
  return stdin;
}

describe("promptCommand", () => {
  test("returns selected command from menu", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const promise = promptCommand({ stdin, stdout });
    stdin.push("\r");
    const command = await promise;
    expect(command).toBe("setup");
  });

  test("menu includes new ops commands", () => {
    const values = COMMAND_MENU_OPTIONS.map((opt) => opt.value);
    expect(values).toContain("config");
    expect(values).toContain("list");
    expect(values).toContain("status");
    expect(values).toContain("log");
    expect(values).toContain("restart");
  });
});

describe("parseParents", () => {
  test("splits comma-separated directories", () => {
    expect(parseParents("~/Sites, ~/Work")).toEqual(["~/Sites", "~/Work"]);
  });
});

describe("parseInitArgs", () => {
  test("parses parents force and launchd flags", () => {
    expect(parseInitArgs(["--parents", "~/Sites,~/Work", "--force", "--no-launchd"])).toEqual({
      parents: ["~/Sites", "~/Work"],
      force: true,
      launchd: false,
      help: false,
    });
  });
});

describe("parseSetupArgs", () => {
  test("parses project dir and connection flags", () => {
    expect(
      parseSetupArgs([
        "~/Sites/app",
        "--host",
        "sftp.example.com",
        "--username",
        "deploy",
        "--remote-path",
        "/var/www/app",
        "--check",
        "--already-synced",
      ]),
    ).toEqual({
      projectDir: "~/Sites/app",
      host: "sftp.example.com",
      port: null,
      username: "deploy",
      privateKeyPath: null,
      remotePath: "/var/www/app",
      force: null,
      check: true,
      syncBootstrap: "seed",
      help: false,
    });
  });

  test("parses push bootstrap flags", () => {
    expect(parseSetupArgs(["--push"]).syncBootstrap).toBe("push");
    expect(parseSetupArgs(["--no-push"]).syncBootstrap).toBe("skip");
  });
});

describe("parsePushArgs", () => {
  test("collects paths when no project dir is given", async () => {
    const { parsePushArgs } = await import("./commands/push.js");
    expect(parsePushArgs(["package.json", "src/"])).toEqual({
      projectDir: null,
      paths: ["package.json", "src/"],
      force: false,
      help: false,
    });
  });

  test("parses --force and --project", async () => {
    const { parsePushArgs } = await import("./commands/push.js");
    expect(parsePushArgs(["--project", "~/Sites/app", "index.html", "--force"])).toEqual({
      projectDir: "~/Sites/app",
      paths: ["index.html"],
      force: true,
      help: false,
    });
  });

  test("relative nested dirs stay paths even with sync-config", async () => {
    const { parsePushArgs, looksLikeProjectRoot, isExplicitProjectDirArg } =
      await import("./commands/push.js");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, basename } = await import("node:path");

    const parent = mkdtempSync(join(tmpdir(), "sftp-push-args-"));
    const nested = join(parent, "vendor");
    try {
      mkdirSync(join(nested, ".sftp-autosync"), { recursive: true });
      writeFileSync(
        join(nested, ".sftp-autosync", "sync-config.json"),
        JSON.stringify({
          host: "h",
          username: "u",
          remotePath: "/r",
          privateKeyPath: "~/.ssh/id_ed25519",
        }),
      );

      // Relative name is not an explicit project-dir token.
      expect(isExplicitProjectDirArg(basename(nested))).toBe(false);
      expect(looksLikeProjectRoot(nested)).toBe(true);

      const cwd = process.cwd();
      process.chdir(parent);
      try {
        expect(parsePushArgs([basename(nested)])).toEqual({
          projectDir: null,
          paths: [basename(nested)],
          force: false,
          help: false,
        });
      } finally {
        process.chdir(cwd);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("looksLikeProjectRoot returns false for corrupt sync-config", async () => {
    const { looksLikeProjectRoot } = await import("./commands/push.js");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = mkdtempSync(join(tmpdir(), "sftp-push-bad-"));
    try {
      mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
      writeFileSync(join(root, ".sftp-autosync", "sync-config.json"), "{bad");
      expect(looksLikeProjectRoot(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveSyncBootstrap", () => {
  test("honors flags and defaults non-interactive to skip", async () => {
    const { resolveSyncBootstrap } = await import("./commands/setup.js");
    expect(await resolveSyncBootstrap("seed", false)).toBe("seed");
    expect(await resolveSyncBootstrap("push", false)).toBe("push");
    expect(await resolveSyncBootstrap("skip", false)).toBe("skip");
    expect(await resolveSyncBootstrap(null, false)).toBe("skip");
  });
});

describe("applySyncBootstrap", () => {
  test("seeds hashes even when SSH check already failed", async () => {
    const { applySyncBootstrap } = await import("./commands/setup.js");
    const { loadContentHashes } = await import("./content-hashes.js");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = mkdtempSync(join(tmpdir(), "sftp-bootstrap-"));
    try {
      writeFileSync(join(root, "index.html"), "<html></html>\n");
      const logs = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(" "));
      try {
        await applySyncBootstrap({
          bootstrap: "seed",
          projectDir: root,
          globalConfig: { ignore: [".sftp-autosync", "node_modules"] },
          sshOk: false,
          checkedSsh: true,
        });
      } finally {
        console.log = originalLog;
      }

      expect(loadContentHashes(root).size).toBe(1);
      expect(logs.some((line) => line.includes("Seeded 1 content hash"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips push when SSH check failed", async () => {
    const { applySyncBootstrap } = await import("./commands/setup.js");
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await applySyncBootstrap({
        bootstrap: "push",
        projectDir: "/tmp/does-not-matter",
        globalConfig: { ignore: [], ssh: {}, concurrency: 1, notify: {} },
        sshOk: false,
        checkedSsh: true,
      });
    } finally {
      console.log = originalLog;
    }
    expect(logs.some((line) => line.includes("Skipping initial push"))).toBe(true);
  });
});
