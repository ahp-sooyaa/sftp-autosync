import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearUserDataDirForTests,
  exampleConfigPath,
  globalConfigPath,
  isInitialized,
  legacyConfigPath,
  migrateLegacyConfig,
  resolveConfigArg,
  resolveGlobalConfigPath,
  setUserDataDirForTests,
  userDataDir,
} from "./paths.js";

describe("paths", () => {
  let tempUserData;
  let tempPackage;

  beforeEach(() => {
    tempUserData = mkdtempSync(join(tmpdir(), "sftp-userdata-"));
    tempPackage = mkdtempSync(join(tmpdir(), "sftp-package-"));
    setUserDataDirForTests(tempUserData);
  });

  afterEach(() => {
    clearUserDataDirForTests();
    rmSync(tempUserData, { recursive: true, force: true });
    rmSync(tempPackage, { recursive: true, force: true });
  });

  test("globalConfigPath resolves under user data dir", () => {
    expect(globalConfigPath()).toBe(join(tempUserData, "config.json"));
    expect(isInitialized()).toBe(false);
  });

  test("exampleConfigPath points at packaged example", () => {
    expect(exampleConfigPath(tempPackage)).toBe(join(tempPackage, "config.example.json"));
  });

  test("migrateLegacyConfig copies package-local config when user config missing", () => {
    const legacy = legacyConfigPath(tempPackage);
    writeFileSync(legacy, JSON.stringify({ parents: ["~/Sites"], debounceMs: 100 }));

    const result = migrateLegacyConfig(tempPackage);
    expect(result.migrated).toBe(true);
    expect(result.from).toBe(legacy);
    expect(existsSync(globalConfigPath())).toBe(true);
    expect(JSON.parse(readFileSync(globalConfigPath(), "utf8")).debounceMs).toBe(100);
    expect(isInitialized()).toBe(true);
  });

  test("migrateLegacyConfig is a no-op when user config already exists", () => {
    writeFileSync(join(tempUserData, "config.json"), JSON.stringify({ parents: ["~/Work"] }));
    writeFileSync(legacyConfigPath(tempPackage), JSON.stringify({ parents: ["~/Sites"] }));

    const result = migrateLegacyConfig(tempPackage);
    expect(result.migrated).toBe(false);
    expect(JSON.parse(readFileSync(globalConfigPath(), "utf8")).parents).toEqual(["~/Work"]);
  });

  test("userDataDir is created on migrate", () => {
    writeFileSync(legacyConfigPath(tempPackage), "{}");
    migrateLegacyConfig(tempPackage);
    expect(existsSync(userDataDir())).toBe(true);
  });

  test("resolveGlobalConfigPath migrates legacy config before returning path", () => {
    writeFileSync(legacyConfigPath(tempPackage), JSON.stringify({ parents: ["~/Sites"] }));

    const path = resolveGlobalConfigPath(tempPackage);
    expect(path).toBe(globalConfigPath());
    expect(isInitialized()).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).parents).toEqual(["~/Sites"]);
  });

  test("resolveConfigArg redirects legacy package-local config to Application Support", () => {
    writeFileSync(legacyConfigPath(tempPackage), JSON.stringify({ parents: ["~/Sites"] }));

    const resolved = resolveConfigArg(legacyConfigPath(tempPackage), tempPackage);
    expect(resolved).toBe(globalConfigPath());
    expect(existsSync(resolved)).toBe(true);
  });

  test("resolveConfigArg keeps custom config paths", () => {
    const custom = join(tempUserData, "custom.json");
    writeFileSync(custom, "{}");
    expect(resolveConfigArg(custom, tempPackage)).toBe(custom);
  });
});
