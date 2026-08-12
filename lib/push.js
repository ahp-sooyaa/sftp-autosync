import { existsSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  contentHash,
  listProjectPaths,
  loadContentHashes,
  mergeContentHashUpdates,
  shouldSkipUnchanged,
  uploadedBytesStillMatch,
} from "./content-hashes.js";
import { shouldIgnoreRel } from "./ignore.js";
import { resolveRemotePath } from "./router.js";
import { ProjectVisibility } from "./visibility.js";

/**
 * Upload specific paths or the whole project, then persist content hashes.
 *
 * @param {object} opts
 * @param {object} opts.project
 * @param {string[]} opts.ignore
 * @param {import("./ssh-pool.js").SshPool} opts.pool
 * @param {string[]} [opts.paths] absolute or project-relative; empty = all files
 * @param {ProjectVisibility} [opts.visibility]
 * @param {boolean} [opts.skipUnchanged] skip when hash matches persisted fingerprint
 * @returns {Promise<{ uploaded: number, skipped: number, failed: number }>}
 */
export async function pushProject({
  project,
  ignore,
  pool,
  paths = [],
  visibility = new ProjectVisibility({ notify: false }),
  skipUnchanged = true,
}) {
  const shouldIgnore = (rel) => shouldIgnoreRel(rel, ignore);
  visibility.ensure(project.root);

  const baseline = loadContentHashes(project.root);
  /** @type {Map<string, string>} */
  const upserts = new Map();
  const targets = resolvePushTargets(project.root, paths, shouldIgnore);

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const absolute of targets) {
    const rel = relative(project.root, absolute).split(sep).join("/");
    if (!rel || rel.startsWith("..") || shouldIgnore(rel)) continue;

    let st;
    try {
      st = await stat(absolute);
    } catch {
      failed += 1;
      continue;
    }

    const remote = resolveRemotePath(project, absolute);

    if (st.isDirectory()) {
      try {
        await visibility.track(project, { op: "mkdir", file: rel, remote }, () =>
          pool.mkdir(project, remote),
        );
        uploaded += 1;
      } catch {
        failed += 1;
      }
      continue;
    }

    if (!st.isFile()) continue;

    let bytes;
    try {
      bytes = await readFile(absolute);
    } catch {
      failed += 1;
      continue;
    }

    const hash = contentHash(bytes);
    const previous = upserts.get(absolute) ?? baseline.get(absolute);
    if (skipUnchanged && shouldSkipUnchanged(previous, hash)) {
      skipped += 1;
      continue;
    }

    try {
      await visibility.track(project, { op: "upload", file: rel, remote }, () =>
        pool.upload(project, absolute, remote),
      );
      let afterHash = null;
      try {
        afterHash = contentHash(await readFile(absolute));
      } catch {
        afterHash = null;
      }
      if (uploadedBytesStillMatch(hash, afterHash)) {
        upserts.set(absolute, hash);
      }
      uploaded += 1;
    } catch {
      failed += 1;
    }
  }

  if (upserts.size > 0) {
    mergeContentHashUpdates(project.root, { upserts });
  }
  return { uploaded, skipped, failed };
}

/**
 * Resolve CLI/path args into absolute file paths under the project.
 * Empty paths → every non-ignored file in the tree.
 */
export function resolvePushTargets(projectRoot, paths, shouldIgnore) {
  if (!paths.length) {
    return listProjectPaths(projectRoot, shouldIgnore, "file");
  }

  /** @type {string[]} */
  const out = [];
  for (const raw of paths) {
    const absolute = resolve(projectRoot, raw);
    const rel = relative(projectRoot, absolute).split(sep).join("/");
    if (rel.startsWith("..")) {
      throw new Error(`Path outside project: ${raw}`);
    }
    if (!existsSync(absolute)) {
      throw new Error(`Path not found: ${raw}`);
    }
    if (rel && shouldIgnore(rel)) continue;

    const st = statSync(absolute);
    if (st.isDirectory()) {
      // listProjectPaths walks from projectRoot; filter to this subtree.
      const prefix = rel ? `${rel}/` : "";
      for (const file of listProjectPaths(projectRoot, shouldIgnore, "file")) {
        const fileRel = relative(projectRoot, file).split(sep).join("/");
        if (fileRel === rel || fileRel.startsWith(prefix)) out.push(file);
      }
    } else if (st.isFile() || st.isSymbolicLink()) {
      out.push(absolute);
    }
  }
  return [...new Set(out)];
}
