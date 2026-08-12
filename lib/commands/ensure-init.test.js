import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearUserDataDirForTests, setUserDataDirForTests } from "../paths.js";

describe("ensureInitialized", () => {
  let tempUserData;

  beforeEach(() => {
    tempUserData = mkdtempSync(join(tmpdir(), "sftp-ensure-init-"));
    setUserDataDirForTests(tempUserData);
  });

  afterEach(() => {
    clearUserDataDirForTests();
    rmSync(tempUserData, { recursive: true, force: true });
    mock.restore();
  });

  test("returns immediately when initialized", async () => {
    const { writeFileSync } = await import("node:fs");
    const { globalConfigPath } = await import("../paths.js");
    writeFileSync(globalConfigPath(), JSON.stringify({ parents: ["~/Sites"] }));

    const { ensureInitialized } = await import("./ensure-init.js");
    await expect(ensureInitialized()).resolves.toBeUndefined();
  });

  test("throws in non-interactive mode when not initialized", async () => {
    const { existsSync, renameSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { repoRoot } = await import("../cli.js");

    const legacyPath = join(repoRoot, "config.json");
    const backupPath = `${legacyPath}.ensure-init-test-backup`;
    const hadLegacy = existsSync(legacyPath);
    if (hadLegacy) renameSync(legacyPath, backupPath);

    const stdin = process.stdin;
    const stdout = process.stdout;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

    try {
      const { ensureInitialized } = await import("./ensure-init.js");
      await expect(ensureInitialized()).rejects.toThrow(/Not initialized/);
    } finally {
      if (hadLegacy) renameSync(backupPath, legacyPath);
      Object.defineProperty(process.stdin, "isTTY", { value: stdin.isTTY, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: stdout.isTTY, configurable: true });
    }
  });
});
