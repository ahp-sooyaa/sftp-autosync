import { confirm, intro, outro, select, text } from "@clack/prompts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expandHome } from "../config.js";
import { createGlobalConfig, defaultPaths, ensureParentDirs } from "../init.js";
import { handleCancel, isInteractive, parseParents, repoRoot } from "../cli.js";
import { migrateLegacyConfig } from "../paths.js";

export function parseInitArgs(argv) {
  const opts = {
    parents: null,
    force: null,
    launchd: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--launchd") {
      opts.launchd = true;
    } else if (arg === "--no-launchd") {
      opts.launchd = false;
    } else if (arg === "--parents" && argv[i + 1]) {
      opts.parents = parseParents(argv[++i]);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return opts;
}

export function printInitHelp() {
  console.log(`Usage: sftp-autosync init [options]

Options:
  --parents <dir>[,dir...]   Parked parent folders (default: ~/Sites)
  --force                    Overwrite existing config.json from the example
  --launchd                  Install/load the login LaunchAgent
  --no-launchd               Skip launchd (default when non-interactive)
  -h, --help                 Show help
`);
}

export async function runInit(argv) {
  const opts = parseInitArgs(argv);
  if (opts.help) {
    printInitHelp();
    return;
  }

  const interactive = isInteractive();
  const paths = defaultPaths(repoRoot);

  const migration = migrateLegacyConfig(repoRoot);
  if (migration.migrated) {
    console.log(`Migrated config from ${migration.from} → ${migration.path}`);
  }

  const configExists = existsSync(paths.configPath);

  if (interactive) {
    intro("sftp-autosync init");
  }

  let parents = opts.parents;
  if (!parents) {
    if (!interactive) {
      parents = ["~/Sites"];
    } else {
      const answer = handleCancel(
        await text({
          message: "Parked parent directory",
          placeholder: "~/Sites",
          defaultValue: "~/Sites",
          validate: (value) => {
            if (!parseParents(value).length) return "Enter at least one directory";
          },
        }),
      );
      parents = parseParents(answer);
    }
  }

  let force = opts.force === true;
  if (configExists && opts.force == null) {
    if (!interactive) {
      force = false;
    } else {
      const action = handleCancel(
        await select({
          message: "config.json already exists",
          options: [
            {
              value: "keep",
              label: "Keep existing config",
              hint: "ensure parent folders only",
            },
            {
              value: "overwrite",
              label: "Overwrite from example",
              hint: "resets notify/ssh defaults",
            },
          ],
          initialValue: "keep",
        }),
      );
      force = action === "overwrite";
    }
  }

  const result = createGlobalConfig({
    ...paths,
    parents,
    force,
  });

  if (result.created) {
    console.log(`Wrote ${result.path}`);
  } else {
    console.log(`Keeping ${result.path}`);
    if (opts.parents) {
      console.log("Note: --parents ignored while keeping existing config");
    }
  }

  const createdDirs = ensureParentDirs(result.parents);
  for (const dir of createdDirs) {
    console.log(`Created parent ${dir}`);
  }
  for (const parent of result.parents) {
    console.log(`Parent ${expandHome(parent)}`);
  }

  let installLaunchd = opts.launchd;
  if (installLaunchd == null) {
    if (!interactive) {
      installLaunchd = false;
    } else {
      installLaunchd = handleCancel(
        await confirm({
          message: "Install launchd agent to start at login?",
          active: "Yes",
          inactive: "No",
          initialValue: false,
        }),
      );
    }
  }

  if (installLaunchd) {
    const proc = Bun.spawn(["bun", resolve(repoRoot, "launchd/install.js")], {
      cwd: repoRoot,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`launchd install failed (exit ${code})`);
    }
  } else {
    console.log("Skipped launchd (later: sftp-autosync init --launchd)");
  }

  if (interactive) {
    outro("Next: cd into a project and run  sftp-autosync setup");
  } else {
    console.log("Next: sftp-autosync setup");
  }
}
