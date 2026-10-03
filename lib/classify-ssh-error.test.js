import { describe, expect, test } from "bun:test";
import { classifySshError } from "./classify-ssh-error.js";

describe("classifySshError", () => {
  test("classifies host key failures", () => {
    expect(
      classifySshError("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!"),
    ).toBe("hostkey");
    expect(classifySshError("Host key verification failed.")).toBe("hostkey");
  });

  test("classifies auth failures", () => {
    expect(classifySshError("Permission denied (publickey).")).toBe("auth");
    expect(classifySshError("Authentication failed.")).toBe("auth");
  });

  test("classifies connection failures", () => {
    expect(classifySshError("ssh: connect to host x port 22: Connection refused")).toBe(
      "connect",
    );
    expect(classifySshError("Could not resolve hostname example.invalid")).toBe("connect");
  });

  test("classifies disk space", () => {
    expect(classifySshError("scp: /var/www/x: No space left on device")).toBe("space");
  });

  test("classifies remote permission after auth", () => {
    expect(classifySshError("scp: /var/www/x: Permission denied")).toBe("permission");
    expect(classifySshError("Read-only file system")).toBe("permission");
  });

  test("returns null for unknown text", () => {
    expect(classifySshError("scp failed: exit 255")).toBeNull();
  });
});
