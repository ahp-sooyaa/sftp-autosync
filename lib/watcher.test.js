import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectPathKinds,
  opaqueResyncPaths,
  pathsUnderRoot,
  shouldRemoveRemoteTree,
} from "./watcher.js";

describe("collectPathKinds", () => {
  test("records pre-existing directories as dir for delete routing", () => {
    const root = mkdtempSync(join(tmpdir(), "sftp-kinds-"));
    const assets = join(root, "assets");
    mkdirSync(assets);
    writeFileSync(join(assets, "a.txt"), "x");
    mkdirSync(join(root, ".sftp-autosync"));
    writeFileSync(join(root, ".sftp-autosync", "sync-config.json"), "{}");

    try {
      const kinds = collectPathKinds(root, (rel) => rel.split("/")[0] === ".sftp-autosync");
      expect(kinds.get(assets)).toBe("dir");
      expect(kinds.get(join(assets, "a.txt"))).toBe("file");
      expect(kinds.has(join(root, ".sftp-autosync"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pathsUnderRoot", () => {
  test("selects pending paths that belong to a dropped project", () => {
    const root = "/parked/demo";
    const keys = [
      "/parked/demo/index.html",
      "/parked/demo/assets/a.css",
      "/parked/other/file.txt",
      "/parked/demo-extra/x",
    ];
    expect(pathsUnderRoot(keys, root).sort()).toEqual([
      "/parked/demo/assets/a.css",
      "/parked/demo/index.html",
    ]);
  });

  test("includes the project root itself", () => {
    expect(pathsUnderRoot(["/parked/demo", "/parked/demo/a"], "/parked/demo")).toEqual([
      "/parked/demo",
      "/parked/demo/a",
    ]);
  });
});

describe("shouldRemoveRemoteTree", () => {
  test("uses recursive delete for dirs and trees with remembered children", () => {
    expect(shouldRemoveRemoteTree("dir", false)).toBe(true);
    expect(shouldRemoveRemoteTree("file", true)).toBe(true);
    expect(shouldRemoveRemoteTree(undefined, true)).toBe(true);
    expect(shouldRemoveRemoteTree("file", false)).toBe(false);
    expect(shouldRemoveRemoteTree(undefined, false)).toBe(false);
  });
});

describe("opaqueResyncPaths", () => {
  test("unions live and remembered paths for null-filename fallback", () => {
    expect(opaqueResyncPaths(["/a", "/b"], ["/b", "/c"]).sort()).toEqual(["/a", "/b", "/c"]);
  });
});
