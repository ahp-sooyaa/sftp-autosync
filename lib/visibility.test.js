import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectVisibility, STATUS_FILE } from "./visibility.js";

describe("ProjectVisibility sticky lastError", () => {
  /** @type {string | null} */
  let root = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function makeProject() {
    root = mkdtempSync(join(tmpdir(), "sftp-vis-"));
    mkdirSync(join(root, ".sftp-autosync"), { recursive: true });
    return { name: "demo", root };
  }

  function readStatus(projectRoot) {
    const raw = readFileSync(join(projectRoot, ".sftp-autosync", STATUS_FILE), "utf8");
    return JSON.parse(raw);
  }

  test("file A error then file B ok keeps lastError for A", async () => {
    const project = makeProject();
    const visibility = new ProjectVisibility({ notify: false });

    await visibility
      .track(project, { op: "upload", file: "a.txt", remote: "/r/a" }, async () => {
        throw new Error("fail a");
      })
      .catch(() => {});

    await visibility.track(
      project,
      { op: "upload", file: "b.txt", remote: "/r/b" },
      async () => {},
    );

    const status = readStatus(project.root);
    expect(status.state).toBe("ok");
    expect(status.file).toBe("b.txt");
    expect(status.lastError).toEqual({
      file: "a.txt",
      error: "fail a",
      at: expect.any(String),
    });
  });

  test("success on lastError file clears lastError", async () => {
    const project = makeProject();
    const visibility = new ProjectVisibility({ notify: false });

    await visibility
      .track(project, { op: "upload", file: "a.txt", remote: "/r/a" }, async () => {
        throw new Error("fail a");
      })
      .catch(() => {});

    await visibility.track(
      project,
      { op: "upload", file: "a.txt", remote: "/r/a" },
      async () => {},
    );

    const status = readStatus(project.root);
    expect(status.state).toBe("ok");
    expect(status.lastError).toBeNull();
  });

  test("isRetry suppresses failure notification path without changing lastError", async () => {
    const project = makeProject();
    const visibility = new ProjectVisibility({ notify: false });

    await visibility
      .track(
        project,
        { op: "upload", file: "x.txt", remote: "/r/x", isRetry: true },
        async () => {
          throw new Error("retry fail");
        },
      )
      .catch(() => {});

    const status = readStatus(project.root);
    expect(status.lastError?.file).toBe("x.txt");
    expect(status.lastError?.error).toBe("retry fail");
    expect(existsSync(join(project.root, ".sftp-autosync", STATUS_FILE))).toBe(true);
  });
});
