import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findDuplicateRemoteTargets,
  formatDuplicateRemoteTargetWarning,
  isParkedProject,
  loadProjectConfig,
  parseProjectMode,
  remotePathsOverlap,
} from "./config.js";

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

describe("parseProjectMode", () => {
  test("defaults missing or unknown values to auto", () => {
    expect(parseProjectMode(undefined)).toBe("auto");
    expect(parseProjectMode("autosync")).toBe("auto");
  });

  test("accepts manual and auto", () => {
    expect(parseProjectMode("manual")).toBe("manual");
    expect(parseProjectMode("auto")).toBe("auto");
  });
});

describe("loadProjectConfig mode", () => {
  test("reads manual mode and defaults missing to auto", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-mode-"));
    const manualRoot = join(root, "manual-app");
    const legacyRoot = join(root, "legacy-app");
    mkdirSync(join(manualRoot, ".sftp-autosync"), { recursive: true });
    mkdirSync(join(legacyRoot, ".sftp-autosync"), { recursive: true });
    writeFileSync(
      join(manualRoot, ".sftp-autosync", "sync-config.json"),
      `${JSON.stringify({
        host: "127.0.0.1",
        username: "deploy",
        privateKeyPath: "~/.ssh/id_ed25519",
        remotePath: "/var/www/manual",
        mode: "manual",
      })}\n`,
    );
    writeFileSync(
      join(legacyRoot, ".sftp-autosync", "sync-config.json"),
      `${JSON.stringify({
        host: "127.0.0.1",
        username: "deploy",
        privateKeyPath: "~/.ssh/id_ed25519",
        remotePath: "/var/www/legacy",
      })}\n`,
    );

    try {
      expect(loadProjectConfig(manualRoot)?.mode).toBe("manual");
      expect(loadProjectConfig(legacyRoot)?.mode).toBe("auto");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("remotePathsOverlap", () => {
  test("detects equal and prefix overlap", () => {
    expect(remotePathsOverlap("/var/www", "/var/www")).toBe(true);
    expect(remotePathsOverlap("/var/www", "/var/www/app")).toBe(true);
    expect(remotePathsOverlap("/var/www/app", "/var/www")).toBe(true);
    expect(remotePathsOverlap("/var/www", "/var/other")).toBe(false);
  });
});

describe("findDuplicateRemoteTargets", () => {
  const base = {
    host: "127.0.0.1",
    port: 2222,
    username: "deploy",
    privateKeyPath: "/tmp/id_test",
    routes: [],
  };

  test("returns no conflicts for distinct remote paths", () => {
    const projects = new Map([
      ["/park/demo", { ...base, root: "/park/demo", name: "demo", remotePath: "/sites/demo" }],
      ["/park/other", { ...base, root: "/park/other", name: "other", remotePath: "/sites/other" }],
    ]);
    expect(findDuplicateRemoteTargets(projects)).toEqual([]);
  });

  test("flags identical remotePath on the same host", () => {
    const projects = new Map([
      ["/park/demo", { ...base, root: "/park/demo", name: "demo", remotePath: "/sites/shared" }],
      ["/park/other", { ...base, root: "/park/other", name: "other", remotePath: "/sites/shared" }],
    ]);
    const conflicts = findDuplicateRemoteTargets(projects);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("exact");
    expect(conflicts[0].projects).toEqual(["demo", "other"]);
    expect(conflicts[0].target).toBe("deploy@127.0.0.1:2222:/sites/shared");
  });

  test("flags overlapping route remotes across projects", () => {
    const projects = new Map([
      [
        "/park/demo",
        {
          ...base,
          root: "/park/demo",
          name: "demo",
          remotePath: "/var/www",
          routes: [],
        },
      ],
      [
        "/park/other",
        {
          ...base,
          root: "/park/other",
          name: "other",
          remotePath: "/var/other",
          routes: [{ local: "shared", remote: "/var/www/assets" }],
        },
      ],
    ]);
    const conflicts = findDuplicateRemoteTargets(projects);
    expect(conflicts.some((c) => c.kind === "overlap")).toBe(true);
    const overlap = conflicts.find((c) => c.kind === "overlap");
    expect(overlap?.projects).toEqual(["demo", "other"]);
    expect(overlap?.paths).toEqual(["/var/www", "/var/www/assets"]);
  });

  test("formatDuplicateRemoteTargetWarning describes exact collisions", () => {
    const message = formatDuplicateRemoteTargetWarning({
      kind: "exact",
      projects: ["demo", "other"],
      target: "deploy@127.0.0.1:2222:/sites/demo",
    });
    expect(message).toContain("demo and other");
    expect(message).toContain("deploy@127.0.0.1:2222:/sites/demo");
  });
});
