import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPrivateKeyPath,
  formatDoctorLine,
  parseDoctorArgs,
  runDoctorChecks,
} from "./doctor.js";
import { STATUS_FILE } from "../visibility.js";

describe("parseDoctorArgs", () => {
  test("defaults probe on", () => {
    expect(parseDoctorArgs([])).toEqual({ probe: true, help: false });
  });

  test("parses --no-probe", () => {
    expect(parseDoctorArgs(["--no-probe"])).toEqual({ probe: false, help: false });
  });
});

describe("formatDoctorLine", () => {
  test("marks pass and fail", () => {
    expect(formatDoctorLine({ name: "x", ok: true, detail: "y" })).toBe("[doctor] ok x: y");
    expect(formatDoctorLine({ name: "x", ok: false, detail: "y" })).toBe("[doctor] fail x: y");
  });
});

describe("checkPrivateKeyPath", () => {
  test("rejects missing and loose permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "sftp-doc-key-"));
    try {
      const key = join(dir, "id_test");
      writeFileSync(key, "key\n");
      chmodSync(key, 0o644);
      expect(checkPrivateKeyPath(key).ok).toBe(false);

      chmodSync(key, 0o600);
      expect(checkPrivateKeyPath(key).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runDoctorChecks", () => {
  test("reports lastError and skips ssh with --no-probe", async () => {
    const home = mkdtempSync(join(tmpdir(), "sftp-doc-home-"));
    const park = join(home, "Sites");
    const projectRoot = join(park, "demo");
    const keyPath = join(home, "id_ed25519");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, ".sftp-autosync"), { recursive: true });
    writeFileSync(keyPath, "fake\n");
    chmodSync(keyPath, 0o600);
    writeFileSync(
      join(projectRoot, ".sftp-autosync", "sync-config.json"),
      JSON.stringify({
        host: "127.0.0.1",
        port: 2222,
        username: "deploy",
        privateKeyPath: keyPath,
        remotePath: "/remote/demo",
      }),
    );
    writeFileSync(
      join(projectRoot, ".sftp-autosync", STATUS_FILE),
      `${JSON.stringify(
        {
          project: "demo",
          state: "error",
          file: "a.js",
          error: "Permission denied (publickey).",
          errorKind: "auth",
          lastError: {
            file: "a.js",
            error: "Permission denied (publickey).",
            errorKind: "auth",
            at: "2026-01-01T00:00:00.000Z",
          },
        },
        null,
        2,
      )}\n`,
    );

    const configPath = join(home, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        parents: [park],
        ignore: [".git", "node_modules", ".sftp-autosync"],
      }),
    );

    try {
      const checks = await runDoctorChecks({
        globalConfigPath: configPath,
        probe: false,
        probeLaunchd: async () => ({ loaded: false, detail: "not loaded" }),
      });

      const lastErr = checks.find((c) => c.name === "demo lastError");
      expect(lastErr?.ok).toBe(false);
      expect(lastErr?.detail).toContain("a.js");
      expect(lastErr?.detail).toContain("[auth]");

      const sshSkip = checks.find((c) => c.name === "ssh probe");
      expect(sshSkip?.ok).toBe(true);
      expect(sshSkip?.detail).toContain("skipped");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("runs one ssh probe per identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "sftp-doc-probe-"));
    const park = join(home, "Sites");
    const keyPath = join(home, "id_ed25519");
    writeFileSync(keyPath, "fake\n");
    chmodSync(keyPath, 0o600);

    for (const name of ["a", "b"]) {
      const projectRoot = join(park, name);
      mkdirSync(join(projectRoot, ".sftp-autosync"), { recursive: true });
      writeFileSync(
        join(projectRoot, ".sftp-autosync", "sync-config.json"),
        JSON.stringify({
          host: "127.0.0.1",
          port: 2222,
          username: "deploy",
          privateKeyPath: keyPath,
          remotePath: `/remote/${name}`,
        }),
      );
    }

    const configPath = join(home, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ parents: [park], ignore: [".sftp-autosync"] }),
    );

    let probeCalls = 0;
    try {
      const checks = await runDoctorChecks({
        globalConfigPath: configPath,
        probe: true,
        probeLaunchd: async () => ({ loaded: true, detail: "loaded" }),
        sshCheck: async () => {
          probeCalls += 1;
          return { ok: true, detail: "ok" };
        },
      });

      expect(probeCalls).toBe(1);
      expect(
        checks.some((c) => c.name === `ssh deploy@127.0.0.1:2222:${keyPath}` && c.ok),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("runs separate ssh probes when host matches but keys differ", async () => {
    const home = mkdtempSync(join(tmpdir(), "sftp-doc-probe-keys-"));
    const park = join(home, "Sites");
    const keyA = join(home, "id_a");
    const keyB = join(home, "id_b");
    writeFileSync(keyA, "a\n");
    writeFileSync(keyB, "b\n");
    chmodSync(keyA, 0o600);
    chmodSync(keyB, 0o600);

    const configs = [
      { name: "a", key: keyA },
      { name: "b", key: keyB },
    ];
    for (const { name, key } of configs) {
      const projectRoot = join(park, name);
      mkdirSync(join(projectRoot, ".sftp-autosync"), { recursive: true });
      writeFileSync(
        join(projectRoot, ".sftp-autosync", "sync-config.json"),
        JSON.stringify({
          host: "127.0.0.1",
          port: 2222,
          username: "deploy",
          privateKeyPath: key,
          remotePath: `/remote/${name}`,
        }),
      );
    }

    const configPath = join(home, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ parents: [park], ignore: [".sftp-autosync"] }),
    );

    const probedKeys = [];
    try {
      const checks = await runDoctorChecks({
        globalConfigPath: configPath,
        probe: true,
        probeLaunchd: async () => ({ loaded: true, detail: "loaded" }),
        sshCheck: async ({ privateKeyPath }) => {
          probedKeys.push(privateKeyPath);
          return { ok: true, detail: "ok" };
        },
      });

      expect(probedKeys.sort()).toEqual([keyA, keyB].sort());
      expect(checks.filter((c) => c.name.startsWith("ssh deploy@")).length).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
