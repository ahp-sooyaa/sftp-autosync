import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatListOutput, parseListArgs, runList } from "./list.js";
import {
  clearUserDataDirForTests,
  ensureUserDataDir,
  globalConfigPath,
  setUserDataDirForTests,
} from "../paths.js";

describe("parseListArgs", () => {
  test("parses help flag", () => {
    expect(parseListArgs(["--help"]).help).toBe(true);
  });
});

describe("formatListOutput", () => {
  test("lists parents and projects without privateKeyPath", () => {
    const globalConfig = {
      parents: ["/Users/me/Sites"],
    };
    const projects = new Map([
      [
        "/Users/me/Sites/app",
        {
          name: "app",
          host: "sftp.example.com",
          remotePath: "/var/www/app",
          mode: "manual",
          privateKeyPath: "/secret/key",
        },
      ],
    ]);

    const output = formatListOutput(globalConfig, projects);
    expect(output).toContain("Parked parents:");
    expect(output).toContain("/Users/me/Sites");
    expect(output).toContain("app");
    expect(output).toContain("host: sftp.example.com");
    expect(output).toContain("remote: /var/www/app");
    expect(output).toContain("mode: manual");
    expect(output).not.toContain("privateKeyPath");
    expect(output).not.toContain("/secret/key");
  });

  test("shows none when no projects", () => {
    const output = formatListOutput({ parents: ["/Sites"] }, new Map());
    expect(output).toContain("(none)");
  });
});

describe("runList", () => {
  let tempUserData;
  let parkedParent;
  let projectRoot;

  beforeEach(() => {
    tempUserData = mkdtempSync(join(tmpdir(), "sftp-list-"));
    parkedParent = mkdtempSync(join(tmpdir(), "sftp-list-parent-"));
    projectRoot = join(parkedParent, "my-app");
    mkdirSync(join(projectRoot, ".sftp-autosync"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".sftp-autosync", "sync-config.json"),
      JSON.stringify({
        host: "sftp.example.com",
        username: "deploy",
        remotePath: "/var/www/my-app",
        privateKeyPath: "~/.ssh/id_ed25519",
      }),
    );

    setUserDataDirForTests(tempUserData);
    ensureUserDataDir();
    writeFileSync(globalConfigPath(), `${JSON.stringify({ parents: [parkedParent] }, null, 2)}\n`);
  });

  afterEach(() => {
    clearUserDataDirForTests();
    rmSync(tempUserData, { recursive: true, force: true });
    rmSync(parkedParent, { recursive: true, force: true });
  });

  test("prints discovered projects", async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join("\n"));
    try {
      await runList([]);
    } finally {
      console.log = originalLog;
    }

    const output = logs.join("\n");
    expect(output).toContain(parkedParent);
    expect(output).toContain("my-app");
    expect(output).toContain("sftp.example.com");
  });
});
