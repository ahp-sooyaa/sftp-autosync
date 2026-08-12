import { describe, expect, test } from "bun:test";
import { parseParents } from "./cli.js";
import { parseInitArgs } from "./commands/init.js";
import { parseSetupArgs } from "./commands/setup.js";

describe("parseParents", () => {
  test("splits comma-separated directories", () => {
    expect(parseParents("~/Sites, ~/Work")).toEqual(["~/Sites", "~/Work"]);
  });
});

describe("parseInitArgs", () => {
  test("parses parents force and launchd flags", () => {
    expect(parseInitArgs(["--parents", "~/Sites,~/Work", "--force", "--no-launchd"])).toEqual({
      parents: ["~/Sites", "~/Work"],
      force: true,
      launchd: false,
      help: false,
    });
  });
});

describe("parseSetupArgs", () => {
  test("parses project dir and connection flags", () => {
    expect(
      parseSetupArgs([
        "~/Sites/app",
        "--host",
        "sftp.example.com",
        "--username",
        "deploy",
        "--remote-path",
        "/var/www/app",
        "--check",
      ]),
    ).toEqual({
      projectDir: "~/Sites/app",
      host: "sftp.example.com",
      port: null,
      username: "deploy",
      privateKeyPath: null,
      remotePath: "/var/www/app",
      force: null,
      check: true,
      help: false,
    });
  });
});
