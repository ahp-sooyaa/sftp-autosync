import { reloadLaunchAgent } from "../launchd-install.js";

export function parseRestartArgs(argv) {
  const opts = { help: false };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return opts;
}

export function printRestartHelp() {
  console.log(`Usage: sftp-autosync restart [options]

Options:
  -h, --help            Show help

Reload the launchd agent (unload then load the existing plist).
`);
}

export async function runRestart(argv, { reload = reloadLaunchAgent } = {}) {
  const opts = parseRestartArgs(argv);
  if (opts.help) {
    printRestartHelp();
    return;
  }

  const { plistPath } = await reload();
  console.log(`Reloaded ${plistPath}`);
}
