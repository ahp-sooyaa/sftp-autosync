import { relative, sep } from "node:path";

/**
 * Map a local absolute path under a project to a remote absolute path.
 * Longest matching routes[].local prefix wins; otherwise remotePath.
 */
export function resolveRemotePath(project, localAbsolutePath) {
  const rel = relative(project.root, localAbsolutePath);
  if (!rel || rel.startsWith("..")) {
    throw new Error(`Path outside project: ${localAbsolutePath}`);
  }

  const posixRel = rel.split(sep).join("/");
  const routes = [...project.routes].sort((a, b) => b.local.length - a.local.length);

  for (const route of routes) {
    if (posixRel === route.local || posixRel.startsWith(`${route.local}/`)) {
      const rest = posixRel.slice(route.local.length).replace(/^\//, "");
      return rest ? joinRemote(route.remote, rest) : route.remote;
    }
  }

  return joinRemote(project.remotePath, posixRel);
}

function joinRemote(base, rest) {
  if (!rest) return base;
  if (base === "/") return `/${rest}`;
  return `${base}/${rest}`;
}

/** Remote parent directory for mkdir -p before upload. */
export function remoteDirname(remotePath) {
  const idx = remotePath.lastIndexOf("/");
  if (idx <= 0) return "/";
  return remotePath.slice(0, idx) || "/";
}
