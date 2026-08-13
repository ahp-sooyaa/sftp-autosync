import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cwdHasProjectConfig,
  parseConfigArgs,
  parseEditorCommand,
  resolveConfigAction,
  resolveConfigTarget,
  runConfig,
  shouldPromptConfigAction,
  shouldPromptConfigTarget,
} from "./config.js";
import {
  clearUserDataDirForTests,
  ensureUserDataDir,
  globalConfigPath,
  setUserDataDirForTests,
} from "../paths.js";

describe("parseConfigArgs", () => {
  test("parses global project edit and path flags", () => {
    expect(parseConfigArgs(["--global", "--edit"])).toEqual({
      global: true,
      project: false,
      projectDir: null,
      edit: true,
      path: false,
      help: false,
    });
    expect(parseConfigArgs(["--project", "/tmp/app", "--path"])).toEqual({
      global: false,
      project: true,
      projectDir: "/tmp/app",
      edit: false,
      path: true,
      help: false,
    });
  });

  test("rejects conflicting flags", () => {
    expect(() => parseConfigArgs(["--global", "--project"])).toThrow();
    expect(() => parseConfigArgs(["--edit", "--path"])).toThrow();
  });
});

describe("resolveConfigTarget", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sftp-config-target-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("defaults to project when cwd has sync-config", () => {
    mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
    writeFileSync(join(root, ".sftp-autosync", "sync-config.json"), "{}");
    expect(resolveConfigTarget(parseConfigArgs([]), root).target).toBe("project");
  });

  test("defaults to global when cwd has no project config", () => {
    expect(resolveConfigTarget(parseConfigArgs([]), root).target).toBe("global");
  });

  test("--global wins over cwd project config", () => {
    mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
    writeFileSync(join(root, ".sftp-autosync", "sync-config.json"), "{}");
    expect(resolveConfigTarget(parseConfigArgs(["--global"]), root).target).toBe("global");
  });
});

describe("parseEditorCommand", () => {
  test("splits editor and flags", () => {
    expect(parseEditorCommand("code --wait")).toEqual(["code", "--wait"]);
    expect(parseEditorCommand("emacs -nw")).toEqual(["emacs", "-nw"]);
    expect(parseEditorCommand('"My Editor" --flag')).toEqual(["My Editor", "--flag"]);
  });
});

describe("openInEditor", () => {
  test("passes parsed editor argv to spawn", async () => {
    const { openInEditor } = await import("./config.js");
    let spawned;
    await openInEditor("/tmp/config.json", {
      env: { EDITOR: "code --wait" },
      spawn: (args, opts) => {
        spawned = { args, opts };
        return { exited: Promise.resolve(0) };
      },
    });
    expect(spawned.args).toEqual(["code", "--wait", "/tmp/config.json"]);
  });
});

describe("shouldPromptConfigTarget", () => {
  test("skips prompt when --edit or --path already set", () => {
    expect(shouldPromptConfigTarget(parseConfigArgs(["--edit"]), true)).toBe(false);
    expect(shouldPromptConfigTarget(parseConfigArgs(["--path"]), true)).toBe(false);
  });

  test("prompts in a TTY when no flags are given", () => {
    expect(shouldPromptConfigTarget(parseConfigArgs([]), true)).toBe(true);
    expect(shouldPromptConfigTarget(parseConfigArgs([]), false)).toBe(false);
  });
});

describe("shouldPromptConfigAction", () => {
  test("skips prompt when --edit or --path already set", () => {
    expect(shouldPromptConfigAction(parseConfigArgs(["--edit"]), true)).toBe(false);
    expect(shouldPromptConfigAction(parseConfigArgs(["--global"]), true)).toBe(true);
  });
});

describe("resolveConfigAction", () => {
  test("maps flags to actions", () => {
    expect(resolveConfigAction(parseConfigArgs([]))).toBe("print");
    expect(resolveConfigAction(parseConfigArgs(["--edit"]))).toBe("edit");
    expect(resolveConfigAction(parseConfigArgs(["--path"]))).toBe("path");
  });
});

describe("cwdHasProjectConfig", () => {
  test("detects sync-config presence even when invalid JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-config-cwd-"));
    try {
      expect(cwdHasProjectConfig(root)).toBe(false);
      mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
      writeFileSync(join(root, ".sftp-autosync", "sync-config.json"), "{bad");
      expect(cwdHasProjectConfig(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runConfig", () => {
  let tempUserData;
  let projectRoot;

  beforeEach(() => {
    tempUserData = mkdtempSync(join(tmpdir(), "sftp-config-run-"));
    projectRoot = mkdtempSync(join(tmpdir(), "sftp-config-proj-"));
    setUserDataDirForTests(tempUserData);
    ensureUserDataDir();
    writeFileSync(globalConfigPath(), `${JSON.stringify({ parents: ["~/Sites"] }, null, 2)}\n`);
  });

  afterEach(() => {
    clearUserDataDirForTests();
    rmSync(tempUserData, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("prints global config with --global --path", async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runConfig(["--global", "--path"]);
    } finally {
      console.log = originalLog;
    }
    expect(logs).toEqual([globalConfigPath()]);
  });

  test("prints project config contents", async () => {
    mkdirSync(join(projectRoot, ".sftp-autosync"), { recursive: true });
    const body = '{"host":"h"}\n';
    writeFileSync(join(projectRoot, ".sftp-autosync", "sync-config.json"), body);

    const labels = [];
    const chunks = [];
    const originalLog = console.log;
    const originalWrite = process.stdout.write.bind(process.stdout);
    console.log = (...args) => labels.push(args.join(" "));
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await runConfig(["--project", projectRoot], { cwd: projectRoot });
    } finally {
      console.log = originalLog;
      process.stdout.write = originalWrite;
    }

    expect(labels[0]).toContain("project config:");
    expect(chunks.join("")).toBe(body);
  });

  test("errors when project config is missing", async () => {
    await expect(runConfig(["--project", projectRoot])).rejects.toThrow("Run: sftp-autosync setup");
  });

  test("--edit uses injected editor", async () => {
    let edited;
    await runConfig(["--global", "--edit"], {
      openEditor: async (path) => {
        edited = path;
      },
    });
    expect(edited).toBe(globalConfigPath());
  });

  test("TTY --edit uses project config when cwd has sync-config", async () => {
    mkdirSync(join(projectRoot, ".sftp-autosync"), { recursive: true });
    writeFileSync(join(projectRoot, ".sftp-autosync", "sync-config.json"), "{}\n");

    let edited;
    await runConfig(["--edit"], {
      cwd: projectRoot,
      interactive: true,
      openEditor: async (path) => {
        edited = path;
      },
    });
    expect(edited).toBe(join(projectRoot, ".sftp-autosync", "sync-config.json"));
  });
});
