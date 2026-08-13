import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  CANCEL_SYMBOL,
  cancel,
  confirm,
  createCaptureStdout,
  intro,
  isCancel,
  outro,
  select,
  text,
} from "./prompts.js";

function createFakeStdin() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (mode) => {
    stdin.isRaw = mode;
  };
  return stdin;
}

function pushKeys(stdin, keys) {
  for (const key of keys) {
    stdin.push(key);
  }
}

describe("prompt chrome", () => {
  test("intro outro cancel write bar glyphs", () => {
    const stdout = createCaptureStdout();
    const io = { stdout };

    intro("sftp-autosync init", io);
    outro("Done.", io);
    cancel("Cancelled.", io);

    const out = stdout.getOutput();
    expect(out).toContain("┌");
    expect(out).toContain("sftp-autosync init");
    expect(out).toContain("└");
    expect(out).toContain("Done.");
    expect(out).toContain("■");
    expect(out).toContain("Cancelled.");
  });
});

describe("isCancel", () => {
  test("recognizes cancel symbol", () => {
    expect(isCancel(CANCEL_SYMBOL)).toBe(true);
    expect(isCancel("hello")).toBe(false);
    expect(isCancel(undefined)).toBe(false);
  });
});

describe("text", () => {
  test("uses defaultValue on empty Enter", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const io = { stdin, stdout };

    const promise = text(
      {
        message: "SSH port",
        placeholder: "22",
        defaultValue: "22",
      },
      io,
    );

    pushKeys(stdin, "\r");
    const result = await promise;

    expect(result).toBe("22");
    expect(stdout.getOutput()).toContain("◇");
    expect(stdout.getOutput()).toContain("22");
  });

  test("validate rejects then accepts", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const io = { stdin, stdout };

    const promise = text(
      {
        message: "SSH host",
        validate: (value) => {
          if (!String(value || "").trim()) return "Host is required";
        },
      },
      io,
    );

    pushKeys(stdin, "\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(stdout.getOutput()).toContain("Host is required");

    pushKeys(stdin, "sftp.example.com");
    pushKeys(stdin, "\r");
    const result = await promise;

    expect(result).toBe("sftp.example.com");
  });

  test("Escape returns cancel symbol", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const io = { stdin, stdout };

    const promise = text({ message: "SSH host" }, io);
    pushKeys(stdin, "\x1b");
    const result = await promise;

    expect(isCancel(result)).toBe(true);
  });

  test("Ctrl+C returns cancel symbol", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const io = { stdin, stdout };

    const promise = text({ message: "SSH host" }, io);
    pushKeys(stdin, "\x03");
    const result = await promise;

    expect(isCancel(result)).toBe(true);
  });

  test("accepts UTF-8 characters", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const io = { stdin, stdout };

    const promise = text({ message: "Parked parent directory" }, io);
    stdin.push(Buffer.from("~/Sites/プロジェクト", "utf8"));
    pushKeys(stdin, "\r");
    const result = await promise;

    expect(result).toBe("~/Sites/プロジェクト");
  });

  test("ignores forward-delete escape sequence instead of cancelling", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const io = { stdin, stdout };

    const promise = text({ message: "Remote path" }, io);
    stdin.push(Buffer.from("\x1b[3~", "binary"));
    pushKeys(stdin, "/var/www/app");
    pushKeys(stdin, "\r");
    const result = await promise;

    expect(isCancel(result)).toBe(false);
    expect(result).toBe("/var/www/app");
  });

  test("CRLF submits once", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const io = { stdin, stdout };

    const promise = text({ message: "SSH host", defaultValue: "x" }, io);
    stdin.push(Buffer.from("\r\n"));
    const result = await promise;

    expect(result).toBe("x");
    expect(stdout.getOutput().split("◇").length - 1).toBe(1);
  });
});

describe("select", () => {
  test("arrow down then Enter returns next option value", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const io = { stdin, stdout };

    const promise = select(
      {
        message: "Pick one",
        options: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
        initialValue: "a",
      },
      io,
    );

    pushKeys(stdin, "\x1b[B");
    pushKeys(stdin, "\r");
    const result = await promise;

    expect(result).toBe("b");
    expect(stdout.getOutput()).toContain("Beta");
  });

  test("split arrow sequence still moves after a pause", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const io = { stdin, stdout };

    const promise = select(
      {
        message: "Pick one",
        options: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
        initialValue: "a",
      },
      io,
    );

    stdin.push(Buffer.from("\x1b["));
    await new Promise((r) => setTimeout(r, 30));
    stdin.push(Buffer.from("B"));
    pushKeys(stdin, "\r");
    const result = await promise;

    expect(result).toBe("b");
  });
});

describe("confirm", () => {
  test("initialValue false and Enter returns false", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const io = { stdin, stdout };

    const promise = confirm(
      {
        message: "Install launchd?",
        active: "Yes",
        inactive: "No",
        initialValue: false,
      },
      io,
    );

    pushKeys(stdin, "\r");
    const result = await promise;

    expect(result).toBe(false);
    expect(stdout.getOutput()).toContain("No");
  });

  test("y returns true", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const io = { stdin, stdout };

    const promise = confirm(
      {
        message: "Overwrite?",
        active: "Overwrite",
        inactive: "Keep",
        initialValue: false,
      },
      io,
    );

    pushKeys(stdin, "y");
    const result = await promise;

    expect(result).toBe(true);
    expect(stdout.getOutput()).toContain("Overwrite");
  });

  test("y plus leftover Enter does not auto-submit the next prompt", async () => {
    const stdin = createFakeStdin();
    const stdout = createCaptureStdout();
    const io = { stdin, stdout };

    const confirmed = confirm(
      {
        message: "Overwrite?",
        active: "Overwrite",
        inactive: "Keep",
        initialValue: false,
      },
      io,
    );
    stdin.push(Buffer.from("y\r"));
    expect(await confirmed).toBe(true);

    const typed = text({ message: "SSH host" }, io);
    let settled = false;
    typed.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    pushKeys(stdin, "host.example");
    pushKeys(stdin, "\r");
    expect(await typed).toBe("host.example");
  });
});
