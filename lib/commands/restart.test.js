import { describe, expect, test } from "bun:test";
import { parseRestartArgs, runRestart } from "./restart.js";

describe("parseRestartArgs", () => {
  test("parses help flag", () => {
    expect(parseRestartArgs(["--help"]).help).toBe(true);
  });
});

describe("runRestart", () => {
  test("reloads launch agent via injected reload", async () => {
    let called = false;
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runRestart([], {
        reload: async () => {
          called = true;
          return { plistPath: "/tmp/com.sftp-autosync.plist" };
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(called).toBe(true);
    expect(logs[0]).toContain("Reloaded /tmp/com.sftp-autosync.plist");
  });
});
