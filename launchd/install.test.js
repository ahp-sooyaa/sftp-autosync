import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildProgramArgumentsXml, resolveLaunchdProgramArgs } from "../lib/launchd-install.js";

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
