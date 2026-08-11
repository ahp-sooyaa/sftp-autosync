import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const META_DIR = ".sftp-autosync";
export const CONFIG_FILE = "sync-config.json";
export const LOG_FILE = "sync.log";
export const STATUS_FILE = "status.json";

export function metaDir(projectRoot) {
  return join(projectRoot, META_DIR);
}

export function configPath(projectRoot) {
  return join(metaDir(projectRoot), CONFIG_FILE);
}

/**
 * Per-project log + status.json + optional macOS notifications.
 */
export class ProjectVisibility {
  #notify;
  #slowMs;
  #delayMs;

  constructor({
    notify = true,
    slowMs = 2000,
    delayMs = 0,
    onSuccess = false,
    onFailure = true,
  } = {}) {
    this.#notify = {
      enabled: notify !== false,
      onSuccess: Boolean(onSuccess),
      onFailure: onFailure !== false,
    };
    this.#slowMs = Math.max(0, Number(slowMs) || 0);
    this.#delayMs = Math.max(0, Number(delayMs) || 0);
  }

  ensure(projectRoot) {
    mkdirSync(metaDir(projectRoot), { recursive: true });
  }

  log(project, message) {
    this.ensure(project.root);
    const line = `${new Date().toISOString()} ${message}`;
    appendFileSync(join(metaDir(project.root), LOG_FILE), `${line}\n`);
    console.log(`[${project.name}] ${message}`);
  }

  writeStatus(project, status) {
    this.ensure(project.root);
    const payload = {
      project: project.name,
      at: new Date().toISOString(),
      ...status,
    };
    writeFileSync(
      join(metaDir(project.root), STATUS_FILE),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }

  /**
   * Track an op: status uploading/deleting, log, slow + failure notifies.
   */
  async track(project, { op, file, remote }, work) {
    const label = op === "upload" ? "uploading" : op === "delete" ? "deleting" : op;
    const started = Date.now();
    const where = remote ? `${file} -> ${remote}` : file;

    this.writeStatus(project, {
      state: label,
      op,
      file,
      remote: remote ?? null,
      error: null,
      durationMs: null,
    });
    this.log(project, `${label} ${where}`);

    let slowTimer = null;
    let slowNotified = false;
    if (this.#notify.enabled && this.#slowMs > 0) {
      slowTimer = setTimeout(() => {
        slowNotified = true;
        this.#macNotify(`${project.name}: still ${label}`, file);
      }, this.#slowMs);
    }

    try {
      if (this.#delayMs > 0) {
        await Bun.sleep(this.#delayMs);
      }
      await work();
      const durationMs = Date.now() - started;
      this.writeStatus(project, {
        state: "ok",
        op,
        file,
        remote: remote ?? null,
        error: null,
        durationMs,
      });
      this.log(project, `ok ${op} ${file} (${durationMs}ms)`);
      if (this.#notify.enabled && this.#notify.onSuccess) {
        this.#macNotify(`${project.name}: ${op} ok`, file);
      } else if (slowNotified && this.#notify.enabled) {
        this.#macNotify(`${project.name}: ${op} ok`, `${file} (${durationMs}ms)`);
      }
    } catch (err) {
      const durationMs = Date.now() - started;
      const error = err?.message || String(err);
      this.writeStatus(project, {
        state: "error",
        op,
        file,
        remote: remote ?? null,
        error,
        durationMs,
      });
      this.log(project, `error ${op} ${file}: ${error}`);
      if (this.#notify.enabled && this.#notify.onFailure) {
        this.#macNotify(`${project.name}: ${op} failed`, error.slice(0, 180));
      }
      throw err;
    } finally {
      if (slowTimer) clearTimeout(slowTimer);
    }
  }

  #macNotify(title, body) {
    const safeTitle = escapeAppleScript(title);
    const safeBody = escapeAppleScript(body || "");
    Bun.spawn(["osascript", "-e", `display notification "${safeBody}" with title "${safeTitle}"`], {
      stdout: "ignore",
      stderr: "ignore",
    }).unref?.();
  }
}

function escapeAppleScript(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
