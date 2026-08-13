import { Writable } from "node:stream";

/** Unique symbol returned when the user cancels (Escape / Ctrl+C). */
export const CANCEL_SYMBOL = Symbol("prompt-cancel");

const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `${ESC}[2K`;
const CURSOR_UP = `${ESC}[1A`;

const cyan = (s) => `${ESC}[36m${s}${ESC}[0m`;
const green = (s) => `${ESC}[32m${s}${ESC}[0m`;
const red = (s) => `${ESC}[31m${s}${ESC}[0m`;
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;
const bold = (s) => `${ESC}[1m${s}${ESC}[0m`;

function defaultStdout() {
  return process.stdout;
}

function defaultStdin() {
  return process.stdin;
}

function resolveIo(io) {
  return {
    stdin: io?.stdin ?? defaultStdin(),
    stdout: io?.stdout ?? defaultStdout(),
  };
}

function write(stdout, text) {
  stdout.write(text);
}

function writeln(stdout, text = "") {
  stdout.write(`${text}\n`);
}

export function isCancel(value) {
  return value === CANCEL_SYMBOL;
}

export function intro(message, io) {
  const { stdout } = resolveIo(io);
  writeln(stdout, dim(`┌  ${message}`));
}

export function outro(message, io) {
  const { stdout } = resolveIo(io);
  writeln(stdout, dim(`└  ${message}`));
}

export function cancel(message, io) {
  const { stdout } = resolveIo(io);
  writeln(stdout, red(`■  ${message}`));
}

function submitted(stdout, message, answer) {
  writeln(stdout, green(`◇  ${message}`));
  writeln(stdout, dim(`│  ${answer}`));
}

/** UTF-8 byte length from a lead byte, or 0 if invalid. */
function utf8Needed(lead) {
  if ((lead & 0x80) === 0) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 0;
}

/**
 * Decode one UTF-8 character at `i`, or mark incomplete / skip invalid bytes.
 * @returns {{ char: string, size: number } | { incomplete: true } | { skip: number }}
 */
function consumeUtf8(buf, i) {
  const need = utf8Needed(buf[i]);
  if (need < 2) return { skip: 1 };
  if (i + need > buf.length) return { incomplete: true };
  for (let k = 1; k < need; k++) {
    if ((buf[i + k] & 0xc0) !== 0x80) return { skip: 1 };
  }
  return { char: buf.toString("utf8", i, i + need), size: need };
}

/**
 * Parse an ANSI escape starting at `i` (buf[i] === ESC).
 * Lone ESC is cancel; arrows are keys; other CSI/SS3 sequences are ignored.
 * @returns {{ type: string, size: number } | { incomplete: true, standalone?: boolean }}
 */
function consumeEscape(buf, i) {
  if (i + 1 >= buf.length) return { incomplete: true, standalone: true };

  const next = buf[i + 1];

  if (next === 0x5b) {
    if (i + 2 >= buf.length) return { incomplete: true };
    const third = buf[i + 2];
    if (third === 0x41) return { type: "up", size: 3 };
    if (third === 0x42) return { type: "down", size: 3 };
    if (third === 0x43) return { type: "right", size: 3 };
    if (third === 0x44) return { type: "left", size: 3 };
    let j = i + 2;
    while (j < buf.length) {
      if (buf[j] >= 0x40 && buf[j] <= 0x7e) {
        return { type: "ignore", size: j - i + 1 };
      }
      j += 1;
    }
    return { incomplete: true };
  }

  if (next === 0x4f) {
    if (i + 2 >= buf.length) return { incomplete: true };
    const third = buf[i + 2];
    if (third === 0x41) return { type: "up", size: 3 };
    if (third === 0x42) return { type: "down", size: 3 };
    if (third === 0x43) return { type: "right", size: 3 };
    if (third === 0x44) return { type: "left", size: 3 };
    return { type: "ignore", size: 3 };
  }

  return { type: "ignore", size: 1 };
}

/** Strip leading CR/LF already buffered on stdin so they cannot auto-submit the next prompt. */
function drainLeadingNewlines(stdin) {
  if (typeof stdin.read !== "function") return;
  if (typeof stdin.pause === "function") stdin.pause();

  let leftover = Buffer.alloc(0);
  let chunk;
  while ((chunk = stdin.read()) != null) {
    leftover = Buffer.concat([leftover, Buffer.from(chunk)]);
  }

  let i = 0;
  while (i < leftover.length && (leftover[i] === 0x0d || leftover[i] === 0x0a)) i++;
  const rest = leftover.slice(i);
  if (rest.length > 0 && typeof stdin.unshift === "function") {
    stdin.unshift(rest);
  }
}

function isNewline(byte) {
  return byte === 0x0d || byte === 0x0a;
}

/**
 * Read raw keypresses from stdin until resolve is called.
 * @returns {{ cleanup: () => void }}
 */
function attachKeyReader(stdin, stdout, onKey) {
  drainLeadingNewlines(stdin);

  const wasRaw = stdin.isRaw;
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true);
  }
  write(stdout, HIDE_CURSOR);

  /** Incomplete sequences may arrive across chunks; lone ESC is cancel after a short wait. */
  let pending = Buffer.alloc(0);
  let escTimer = null;
  let stopped = false;

  const clearEscTimer = () => {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
  };

  const flushIncompleteEscape = () => {
    escTimer = null;
    if (stopped) return;
    if (pending.length === 1 && pending[0] === 0x1b) {
      pending = Buffer.alloc(0);
      onKey({ type: "cancel" });
    }
  };

  const scheduleStandaloneEscape = () => {
    clearEscTimer();
    escTimer = setTimeout(flushIncompleteEscape, 20);
  };

  const discardTrailingNewlines = (from) => {
    let rest = pending.slice(from);
    pending = Buffer.alloc(0);
    let i = 0;
    while (i < rest.length && isNewline(rest[i])) i++;
    rest = rest.slice(i);
    drainLeadingNewlines(stdin);
    if (rest.length > 0 && typeof stdin.unshift === "function") {
      stdin.unshift(rest);
    }
  };

  const dispatch = (key) => {
    if (stopped) return true;
    onKey(key);
    return stopped;
  };

  const processPending = () => {
    let i = 0;
    while (i < pending.length) {
      if (stopped) {
        discardTrailingNewlines(i);
        return;
      }

      const b = pending[i];

      if (b === 0x03) {
        i += 1;
        if (dispatch({ type: "cancel" })) {
          discardTrailingNewlines(i);
          return;
        }
        continue;
      }

      if (b === 0x1b) {
        const esc = consumeEscape(pending, i);
        if (esc.incomplete) {
          pending = pending.slice(i);
          if (esc.standalone) scheduleStandaloneEscape();
          return;
        }
        i += esc.size;
        if (esc.type !== "ignore" && dispatch({ type: esc.type })) {
          discardTrailingNewlines(i);
          return;
        }
        continue;
      }

      if (isNewline(b)) {
        if (b === 0x0d && i + 1 < pending.length && pending[i + 1] === 0x0a) {
          i += 2;
        } else {
          i += 1;
        }
        if (dispatch({ type: "enter" })) {
          discardTrailingNewlines(i);
          return;
        }
        continue;
      }

      if (b === 0x7f || b === 0x08) {
        i += 1;
        if (dispatch({ type: "backspace" })) {
          discardTrailingNewlines(i);
          return;
        }
        continue;
      }

      if (b >= 0x20 && b <= 0x7e) {
        i += 1;
        if (dispatch({ type: "char", char: String.fromCharCode(b) })) {
          discardTrailingNewlines(i);
          return;
        }
        continue;
      }

      if (b >= 0x80) {
        const utf = consumeUtf8(pending, i);
        if (utf.incomplete) {
          pending = pending.slice(i);
          return;
        }
        i += utf.size ?? utf.skip;
        if (utf.char && dispatch({ type: "char", char: utf.char })) {
          discardTrailingNewlines(i);
          return;
        }
        continue;
      }

      i += 1;
    }
    pending = Buffer.alloc(0);
    clearEscTimer();
  };

  const onData = (chunk) => {
    if (stopped) return;
    clearEscTimer();
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    processPending();
  };

  stdin.on("data", onData);
  if (typeof stdin.resume === "function") stdin.resume();

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearEscTimer();
    stdin.off("data", onData);
    drainLeadingNewlines(stdin);
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(wasRaw ?? false);
    }
    write(stdout, SHOW_CURSOR);
  };

  return { cleanup };
}

function redrawLines(stdout, lineCount) {
  for (let n = 0; n < lineCount; n++) {
    write(stdout, CLEAR_LINE);
    if (n < lineCount - 1) write(stdout, CURSOR_UP);
  }
}

/**
 * @param {{ stdin?: import('node:stream').Readable, stdout?: Writable }} [io]
 */
export function text(opts, io) {
  const { stdin, stdout } = resolveIo(io);
  const message = opts.message ?? "";
  const placeholder = opts.placeholder ?? "";
  const defaultValue = opts.defaultValue ?? "";
  const validate = opts.validate;

  return new Promise((resolve) => {
    let value = "";
    let error = "";
    let lineCount = 0;
    let settled = false;

    const render = () => {
      const lines = [];
      lines.push(`${cyan("◆")}  ${message}`);
      const display = value.length > 0 ? value : placeholder ? dim(placeholder) : dim("");
      lines.push(`${dim("│")}  ${display}`);
      if (error) {
        lines.push(red(`│  ${error}`));
      }

      if (lineCount > 0) {
        redrawLines(stdout, lineCount);
      }
      for (const line of lines) {
        writeln(stdout, line);
      }
      lineCount = lines.length;
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isCancel(result)) {
        resolve(CANCEL_SYMBOL);
        return;
      }
      redrawLines(stdout, lineCount);
      submitted(stdout, message, String(result));
      resolve(result);
    };

    const { cleanup } = attachKeyReader(stdin, stdout, (key) => {
      if (key.type === "cancel") {
        finish(CANCEL_SYMBOL);
        return;
      }
      if (key.type === "enter") {
        const final = value.length > 0 ? value : defaultValue;
        if (validate) {
          const err = validate(final);
          if (err) {
            error = String(err);
            render();
            return;
          }
        }
        finish(final);
        return;
      }
      if (key.type === "backspace") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          error = "";
          render();
        }
        return;
      }
      if (key.type === "char") {
        value += key.char;
        error = "";
        render();
      }
    });

    render();
  });
}

/**
 * @param {{ stdin?: import('node:stream').Readable, stdout?: Writable }} [io]
 */
export function select(opts, io) {
  const { stdin, stdout } = resolveIo(io);
  const message = opts.message ?? "";
  const options = opts.options ?? [];
  const initialValue = opts.initialValue;

  let index = 0;
  if (initialValue != null) {
    const found = options.findIndex((o) => o.value === initialValue);
    if (found >= 0) index = found;
  }

  return new Promise((resolve) => {
    let lineCount = 0;
    let settled = false;

    const render = () => {
      const lines = [];
      lines.push(`${cyan("◆")}  ${message}`);
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const marker = i === index ? cyan("●") : dim("○");
        const label = i === index ? bold(opt.label) : opt.label;
        const hint = opt.hint ? dim(`  ${opt.hint}`) : "";
        lines.push(`${dim("│")}  ${marker} ${label}${hint}`);
      }

      if (lineCount > 0) {
        redrawLines(stdout, lineCount);
      }
      for (const line of lines) {
        writeln(stdout, line);
      }
      lineCount = lines.length;
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isCancel(result)) {
        resolve(CANCEL_SYMBOL);
        return;
      }
      redrawLines(stdout, lineCount);
      const chosen = options.find((o) => o.value === result);
      submitted(stdout, message, chosen?.label ?? String(result));
      resolve(result);
    };

    const { cleanup } = attachKeyReader(stdin, stdout, (key) => {
      if (key.type === "cancel") {
        finish(CANCEL_SYMBOL);
        return;
      }
      if (key.type === "enter") {
        finish(options[index]?.value);
        return;
      }
      if (key.type === "up") {
        index = index > 0 ? index - 1 : options.length - 1;
        render();
        return;
      }
      if (key.type === "down") {
        index = index < options.length - 1 ? index + 1 : 0;
        render();
      }
    });

    render();
  });
}

/**
 * @param {{ stdin?: import('node:stream').Readable, stdout?: Writable }} [io]
 */
export function confirm(opts, io) {
  const { stdin, stdout } = resolveIo(io);
  const message = opts.message ?? "";
  const active = opts.active ?? "Yes";
  const inactive = opts.inactive ?? "No";
  const initialValue = opts.initialValue ?? true;

  return new Promise((resolve) => {
    let value = initialValue;
    let lineCount = 0;
    let settled = false;

    const formatChoice = () => {
      const yes = value ? bold(active) : dim(active);
      const no = value ? dim(inactive) : bold(inactive);
      return `${yes} / ${no}`;
    };

    const render = () => {
      const lines = [];
      lines.push(`${cyan("◆")}  ${message}`);
      lines.push(`${dim("│")}  ${formatChoice()}`);

      if (lineCount > 0) {
        redrawLines(stdout, lineCount);
      }
      for (const line of lines) {
        writeln(stdout, line);
      }
      lineCount = lines.length;
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isCancel(result)) {
        resolve(CANCEL_SYMBOL);
        return;
      }
      redrawLines(stdout, lineCount);
      submitted(stdout, message, result ? active : inactive);
      resolve(result);
    };

    const { cleanup } = attachKeyReader(stdin, stdout, (key) => {
      if (key.type === "cancel") {
        finish(CANCEL_SYMBOL);
        return;
      }
      if (key.type === "enter") {
        finish(value);
        return;
      }
      if (key.type === "left" || key.type === "right") {
        value = !value;
        render();
        return;
      }
      if (key.type === "char") {
        const c = key.char.toLowerCase();
        if (c === "y") {
          finish(true);
        } else if (c === "n") {
          finish(false);
        }
      }
    });

    render();
  });
}

/** Writable that collects output for tests. */
export function createCaptureStdout() {
  let data = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      data += chunk.toString();
      cb();
    },
  });
  stream.getOutput = () => data;
  stream.clear = () => {
    data = "";
  };
  return stream;
}
