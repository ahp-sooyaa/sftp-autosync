import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome } from "../config.js";
import {
  formatDaemonStatus,
  formatProjectStatus,
  parseStatusArgs,
  probeLaunchdLoaded,
  readProjectStatus,
  resolveStatusScope,
} from "./status.js";

describe("parseStatusArgs", () => {
  test("parses project dir and help", () => {
    expect(parseStatusArgs(["~/Sites/app", "--help"])).toEqual({
      projectDir: "~/Sites/app",
      help: true,
    });
  });
});

describe("probeLaunchdLoaded", () => {
  test("reports loaded when launchctl succeeds", async () => {
    const result = await probeLaunchdLoaded({
      launchctl: async () => ({ code: 0, stdout: "123\t0\tcom.sftp-autosync\n" }),
    });
    expect(result.loaded).toBe(true);
  });

  test("reports not loaded when launchctl fails", async () => {
    const result = await probeLaunchdLoaded({
      launchctl: async () => ({ code: 113, stdout: "" }),
    });
    expect(result.loaded).toBe(false);
  });
});

describe("resolveStatusScope", () => {
  test("expands tilde in projectDir", async () => {
    const scope = await resolveStatusScope({ projectDir: "~/Sites/app" });
    expect(scope).toEqual({
      mode: "one",
      projectDir: resolve(expandHome("~/Sites/app")),
    });
  });
});

describe("formatDaemonStatus", () => {
  test("includes plist installed and loaded flags", () => {
    const output = formatDaemonStatus({
      plistPath: "/tmp/com.sftp-autosync.plist",
      installed: true,
      loaded: false,
      detail: "not loaded",
    });
    expect(output).toContain("plist: /tmp/com.sftp-autosync.plist");
    expect(output).toContain("installed: yes");
    expect(output).toContain("loaded: no");
  });
});

describe("readProjectStatus", () => {
  test("reads status.json fields", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-status-read-"));
    try {
      mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
      writeFileSync(
        join(root, ".sftp-autosync", "status.json"),
        JSON.stringify({
          state: "ok",
          op: "upload",
          file: "index.html",
          at: "2026-08-11T10:00:00.000Z",
          error: null,
        }),
      );

      const status = readProjectStatus(root);
      expect(status.hasStatus).toBe(true);
      expect(status.state).toBe("ok");
      expect(status.op).toBe("upload");
      expect(status.file).toBe("index.html");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns no status when file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-status-missing-"));
    try {
      expect(readProjectStatus(root).hasStatus).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("formatProjectStatus", () => {
  test("formats project with status", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-status-fmt-"));
    try {
      mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
      writeFileSync(
        join(root, ".sftp-autosync", "status.json"),
        JSON.stringify({ state: "error", op: "upload", file: "a.js", error: "timeout" }),
      );

      const output = formatProjectStatus({
        name: "app",
        root,
        host: "h.example.com",
        remotePath: "/var/www/app",
      });
      expect(output).toContain("app:");
      expect(output).toContain("state: error");
      expect(output).toContain("error: timeout");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
