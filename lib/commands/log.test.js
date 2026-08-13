import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonErrLogPath, daemonOutLogPath } from "../paths.js";
import { followLog, parseLogArgs, resolveLogSource, runLog, shouldPromptLogSource } from "./log.js";

describe("parseLogArgs", () => {
  test("parses log source flags", () => {
    expect(parseLogArgs(["--err", "--no-follow"])).toEqual({
      err: true,
      project: false,
      projectDir: null,
      path: false,
      noFollow: true,
      help: false,
    });
    expect(parseLogArgs(["--project", "/tmp/app", "--path"])).toEqual({
      err: false,
      project: true,
      projectDir: "/tmp/app",
      path: true,
      noFollow: false,
      help: false,
    });
  });

  test("rejects --err and --project together", () => {
    expect(() => parseLogArgs(["--err", "--project"])).toThrow();
  });
});

describe("resolveLogSource", () => {
  test("defaults to daemon stdout", () => {
    expect(resolveLogSource(parseLogArgs([])).path).toBe(daemonOutLogPath());
  });

  test("resolves daemon stderr", () => {
    expect(resolveLogSource(parseLogArgs(["--err"])).source).toBe("daemon-err");
    expect(resolveLogSource(parseLogArgs(["--err"])).path).toBe(daemonErrLogPath());
  });

  test("resolves project sync.log", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-log-src-"));
    try {
      const resolved = resolveLogSource(parseLogArgs(["--project", root]), root);
      expect(resolved.source).toBe("project");
      expect(resolved.path).toContain("sync.log");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("shouldPromptLogSource", () => {
  test("skips prompt when --path or --no-follow is set", () => {
    expect(shouldPromptLogSource(parseLogArgs(["--path"]), true)).toBe(false);
    expect(shouldPromptLogSource(parseLogArgs(["--no-follow"]), true)).toBe(false);
  });

  test("prompts in a TTY when no source or output flag is set", () => {
    expect(shouldPromptLogSource(parseLogArgs([]), true)).toBe(true);
    expect(shouldPromptLogSource(parseLogArgs([]), false)).toBe(false);
  });
});

describe("followLog", () => {
  test("treats Ctrl+C exit 130 as success", async () => {
    await followLog("/tmp/out.log", {
      spawn: () => ({
        killed: false,
        kill() {},
        exited: Promise.resolve(130),
      }),
    });
  });

  test("throws on unexpected tail exit codes", async () => {
    await expect(
      followLog("/tmp/out.log", {
        spawn: () => ({
          killed: false,
          kill() {},
          exited: Promise.resolve(1),
        }),
      }),
    ).rejects.toThrow("tail -f exited with code 1");
  });
});

describe("runLog", () => {
  test("--path prints log path", async () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-log-run-"));
    try {
      mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
      const logFile = join(root, ".sftp-autosync", "sync.log");
      writeFileSync(logFile, "line\n");

      const logs = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(" "));
      try {
        await runLog(["--project", root, "--path"], { cwd: root });
      } finally {
        console.log = originalLog;
      }

      expect(logs[0]).toBe(logFile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TTY --path uses daemon stdout without prompting", async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runLog(["--path"], { interactive: true });
    } finally {
      console.log = originalLog;
    }
    expect(logs[0]).toBe(daemonOutLogPath());
  });

  test("--no-follow prints existing contents", async () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-log-nofollow-"));
    try {
      mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
      const logFile = join(root, ".sftp-autosync", "sync.log");
      writeFileSync(logFile, "hello log\n");

      const chunks = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => {
        chunks.push(String(chunk));
        return true;
      };
      try {
        await runLog(["--project", root, "--no-follow"], { cwd: root });
      } finally {
        process.stdout.write = originalWrite;
      }

      expect(chunks.join("")).toBe("hello log\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exits when log file is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-log-missing-"));
    const originalExit = process.exit;
    const originalError = console.error;
    let exitCode;
    const errors = [];
    process.exit = (code) => {
      exitCode = code;
      throw new Error(`exit ${code}`);
    };
    console.error = (...args) => errors.push(args.join(" "));
    try {
      await expect(runLog(["--project", root, "--no-follow"], { cwd: root })).rejects.toThrow(
        "exit 1",
      );
      expect(exitCode).toBe(1);
      expect(errors[0]).toContain("Log not found");
    } finally {
      process.exit = originalExit;
      console.error = originalError;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
