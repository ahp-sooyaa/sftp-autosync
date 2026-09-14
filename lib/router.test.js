import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveRemotePath } from "./router.js";

describe("resolveRemotePath", () => {
  const projectA = {
    root: "/park/demo",
    name: "demo",
    remotePath: "/remote/demo",
    routes: [],
  };

  const projectB = {
    root: "/park/other",
    name: "other",
    remotePath: "/remote/other",
    routes: [{ local: "shared-assets", remote: "/remote/shared" }],
  };

  test("maps files under project A to A's remotePath", () => {
    expect(resolveRemotePath(projectA, join(projectA.root, "index.html"))).toBe(
      "/remote/demo/index.html",
    );
    expect(resolveRemotePath(projectA, join(projectA.root, "assets", "a.css"))).toBe(
      "/remote/demo/assets/a.css",
    );
  });

  test("maps files under project B to B's remotePath", () => {
    expect(resolveRemotePath(projectB, join(projectB.root, "index.html"))).toBe(
      "/remote/other/index.html",
    );
  });

  test("uses longest matching route prefix", () => {
    expect(resolveRemotePath(projectB, join(projectB.root, "shared-assets", "logo.png"))).toBe(
      "/remote/shared/logo.png",
    );
  });

  test("throws for paths outside the project root", () => {
    expect(() => resolveRemotePath(projectA, "/park/other/file.txt")).toThrow(/outside project/);
    expect(() => resolveRemotePath(projectA, "/tmp/file.txt")).toThrow(/outside project/);
  });
});
