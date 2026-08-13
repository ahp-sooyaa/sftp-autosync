import { cancel, confirm } from "../prompts.js";
import { handleCancel, isInteractive, repoRoot } from "../cli.js";
import { isInitialized, migrateLegacyConfig } from "../paths.js";
import { runInit } from "./init.js";

/**
 * Ensure global init has run before setup/start.
 * Interactive: confirm and run init. Non-interactive: throw.
 */
export async function ensureInitialized() {
  migrateLegacyConfig(repoRoot);
  if (isInitialized()) return;

  const interactive = isInteractive();
  if (!interactive) {
    throw new Error("Not initialized. Run: sftp-autosync init");
  }

  const runNow = handleCancel(
    await confirm({
      message: "sftp-autosync is not initialized. Run init now?",
      active: "Yes, run init",
      inactive: "No, exit",
      initialValue: true,
    }),
  );

  if (!runNow) {
    cancel("Run sftp-autosync init first.");
    process.exit(1);
  }

  await runInit([]);
}
