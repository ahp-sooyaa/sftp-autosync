import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildProgramArgumentsXml,
  reloadLaunchAgent,
  resolveLaunchdProgramArgs,
} from "../lib/launchd-install.js";
import { daemonErrLogPath, daemonOutLogPath } from "../lib/paths.js";

describe("resolveLaunchdProgramArgs", () => {
  test("prefers sftp-autosync on PATH when available", () => {
    const args = resolveLaunchdProgramArgs("/pkg/root", "/bin/bun", () => "/opt/bin/sftp-autosync");
    expect(args).toEqual(["/opt/bin/sftp-autosync", "start"]);
  });

  test("falls back to bun + package CLI when not on PATH", () => {
    const args = resolveLaunchdProgramArgs("/pkg/root", "/bin/bun", () => null);
    expect(args).toEqual(["/bin/bun", join("/pkg/root", "bin/sftp-autosync.js"), "start"]);
  });
});

describe("buildProgramArgumentsXml", () => {
  test("escapes XML special characters", () => {
    expect(buildProgramArgumentsXml(['/path/with"quote'])).toContain("&quot;");
  });
});

describe("reloadLaunchAgent", () => {
  test("unloads then loads existing plist", async () => {
    const calls = [];
    const plistPath = "/tmp/com.sftp-autosync.plist";
    const result = await reloadLaunchAgent({
      plistPath,
      exists: (path) => path === plistPath,
      launchctl: async (...args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(calls).toEqual([
      ["unload", plistPath],
      ["load", plistPath],
    ]);
    expect(result.plistPath).toBe(plistPath);
  });

  test("retries load when first load fails after unload", async () => {
    const calls = [];
    const plistPath = "/tmp/com.sftp-autosync.plist";
    let loadAttempts = 0;
    await reloadLaunchAgent({
      plistPath,
      exists: (path) => path === plistPath,
      launchctl: async (...args) => {
        calls.push(args);
        if (args[0] === "load") {
          loadAttempts += 1;
          return loadAttempts === 1 ? 1 : 0;
        }
        return 0;
      },
    });
    expect(calls).toEqual([
      ["unload", plistPath],
      ["load", plistPath],
      ["load", plistPath],
    ]);
  });

  test("throws when load keeps failing after unload", async () => {
    const plistPath = "/tmp/com.sftp-autosync.plist";
    await expect(
      reloadLaunchAgent({
        plistPath,
        exists: (path) => path === plistPath,
        launchctl: async (...args) => (args[0] === "unload" ? 0 : 1),
      }),
    ).rejects.toThrow("sync daemon is stopped");
  });

  test("does not claim daemon is stopped when unload failed", async () => {
    const plistPath = "/tmp/com.sftp-autosync.plist";
    await expect(
      reloadLaunchAgent({
        plistPath,
        exists: (path) => path === plistPath,
        launchctl: async () => 1,
      }),
    ).rejects.toThrow("may still be running");
  });
});

describe("daemon log paths", () => {
  test("resolve under Library/Logs", () => {
    expect(daemonOutLogPath("/Users/me")).toBe(
      join("/Users/me", "Library", "Logs", "sftp-autosync", "out.log"),
    );
    expect(daemonErrLogPath("/Users/me")).toBe(
      join("/Users/me", "Library", "Logs", "sftp-autosync", "err.log"),
    );
  });
});
