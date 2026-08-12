import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isParkedProject } from "./config.js";

describe("isParkedProject", () => {
  test("accepts immediate child of a parked parent", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-parked-"));
    const parent = join(root, "Sites");
    const project = join(parent, "my-app");
    mkdirSync(project, { recursive: true });

    try {
      expect(isParkedProject(project, [parent])).toBe(true);
      expect(isParkedProject(project, ["~/Sites"])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects nested paths and the parent directory itself", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-parked-"));
    const parent = join(root, "Sites");
    const nested = join(parent, "my-app", "src");
    mkdirSync(nested, { recursive: true });

    try {
      expect(isParkedProject(nested, [parent])).toBe(false);
      expect(isParkedProject(parent, [parent])).toBe(false);
      expect(isParkedProject(join(root, "Other", "app"), [parent])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
