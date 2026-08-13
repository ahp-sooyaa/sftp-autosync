import { expandHome, loadGlobalConfig, discoverProjects } from "../config.js";
import { globalConfigPath } from "../paths.js";
import { ensureInitialized } from "./ensure-init.js";

export function parseListArgs(argv) {
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

export function printListHelp() {
  console.log(`Usage: sftp-autosync list [options]

Options:
  -h, --help            Show help

List parked parent directories and synced projects.
`);
}

/**
 * @param {import("../config.js").loadGlobalConfig extends Function ? ReturnType<import("../config.js").loadGlobalConfig> : never} globalConfig
 * @param {Map<string, object>} projects
 */
export function formatListOutput(globalConfig, projects) {
  const lines = [];

  lines.push("Parked parents:");
  for (const parent of globalConfig.parents) {
    lines.push(`  ${expandHome(parent)}`);
  }

  lines.push("");
  lines.push("Synced projects:");
  if (projects.size === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }

  const sorted = [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const project of sorted) {
    lines.push(`  ${project.name}`);
    lines.push(`    host: ${project.host}`);
    lines.push(`    remote: ${project.remotePath}`);
  }

  return lines.join("\n");
}

export async function runList(argv) {
  const opts = parseListArgs(argv);
  if (opts.help) {
    printListHelp();
    return;
  }

  await ensureInitialized();
  const globalConfig = loadGlobalConfig(globalConfigPath());
  const projects = discoverProjects(globalConfig.parents);
  console.log(formatListOutput(globalConfig, projects));
}
