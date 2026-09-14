import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGitChangedPaths, parseNullSeparatedPaths } from "./git-changed.js";

const ignore = [".git", "node_modules", ".DS_Store", ".sftp-autosync", "*.tmp", "*.swp"];

function mockSpawn(handlers) {
  return (argv) => {
    const key = argv.slice(1).join(" ");
    const result = handlers[key];
    if (!result) {
      return {
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exited: Promise.resolve(1),
      };
    }
    const encoder = new TextEncoder();
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(result.stdout ?? ""));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(result.stderr ?? ""));
          controller.close();
        },
      }),
      exited: Promise.resolve(result.exitCode ?? 0),
    };
  };
}

describe("parseNullSeparatedPaths", () => {
  test("parses NUL-separated paths", () => {
    expect(parseNullSeparatedPaths("a.txt\0b.txt\0")).toEqual(["a.txt", "b.txt"]);
    expect(parseNullSeparatedPaths("")).toEqual([]);
  });
});

describe("listGitChangedPaths", () => {
  test("throws when git is unavailable", async () => {
    const spawn = mockSpawn({
      "--version": { exitCode: 1 },
    });
    await expect(listGitChangedPaths("/tmp", { spawn })).rejects.toThrow(/git is not available/);
  });

  test("throws when not a git repository", async () => {
    const spawn = mockSpawn({
      "--version": { exitCode: 0, stdout: "git version 2.0\n" },
      "rev-parse --git-dir": { exitCode: 128, stderr: "not a git repository" },
    });
    await expect(listGitChangedPaths("/tmp", { spawn })).rejects.toThrow(/Not a git repository/);
  });

  test("merges diff and untracked, filters ignore and missing files", async () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-git-changed-"));
    try {
      writeFileSync(join(root, "keep.txt"), "a");
      writeFileSync(join(root, "skip.tmp"), "b");
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "node_modules", "pkg.js"), "c");

      const spawn = mockSpawn({
        "--version": { exitCode: 0, stdout: "git version 2.0\n" },
        "rev-parse --git-dir": { exitCode: 0, stdout: ".git\n" },
        "diff --name-only -z --diff-filter=ACMR HEAD": {
          exitCode: 0,
          stdout: "keep.txt\0gone.txt\0skip.tmp\0node_modules/pkg.js\0",
        },
        "ls-files -z --others --exclude-standard": {
          exitCode: 0,
          stdout: "new.txt\0",
        },
      });

      const paths = await listGitChangedPaths(root, { ignore, spawn });
      expect(paths).toEqual(["keep.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deduplicates paths from diff and untracked", async () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-git-dedup-"));
    try {
      writeFileSync(join(root, "dup.txt"), "a");

      const spawn = mockSpawn({
        "--version": { exitCode: 0, stdout: "git version 2.0\n" },
        "rev-parse --git-dir": { exitCode: 0, stdout: ".git\n" },
        "diff --name-only -z --diff-filter=ACMR HEAD": {
          exitCode: 0,
          stdout: "dup.txt\0",
        },
        "ls-files -z --others --exclude-standard": {
          exitCode: 0,
          stdout: "dup.txt\0",
        },
      });

      const paths = await listGitChangedPaths(root, { ignore, spawn });
      expect(paths).toEqual(["dup.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("listGitChangedPaths (real git)", () => {
  async function runGit(cwd, args) {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
    }
    return stdout;
  }

  test("includes modified, staged, and untracked; excludes deleted", async () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-git-real-"));
    try {
      await runGit(root, ["init", "--initial-branch=main"]);
      await runGit(root, ["config", "user.email", "test@example.com"]);
      await runGit(root, ["config", "user.name", "Test"]);

      writeFileSync(join(root, "tracked.txt"), "v1");
      writeFileSync(join(root, "deleted.txt"), "gone");
      await runGit(root, ["add", "tracked.txt", "deleted.txt"]);
      await runGit(root, ["commit", "-m", "init"]);

      writeFileSync(join(root, "tracked.txt"), "v2");
      writeFileSync(join(root, "staged.txt"), "new");
      writeFileSync(join(root, "untracked.txt"), "u");
      await runGit(root, ["add", "staged.txt"]);
      rmSync(join(root, "deleted.txt"));

      const paths = await listGitChangedPaths(root, { ignore });
      expect(paths).toEqual(["staged.txt", "tracked.txt", "untracked.txt"]);
      expect(paths).not.toContain("deleted.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns empty array for clean repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-git-clean-"));
    try {
      await runGit(root, ["init", "--initial-branch=main"]);
      await runGit(root, ["config", "user.email", "test@example.com"]);
      await runGit(root, ["config", "user.name", "Test"]);
      writeFileSync(join(root, "a.txt"), "a");
      await runGit(root, ["add", "a.txt"]);
      await runGit(root, ["commit", "-m", "init"]);

      const paths = await listGitChangedPaths(root, { ignore });
      expect(paths).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
