import path from "node:path";

import { getDeskRpgUploadsDir } from "./runtime-paths";

const UPLOADS_PREFIX = "/assets/uploads/";

export function resolveRuntimeUploadRequestPath(requestPath: string) {
  if (!requestPath.startsWith(UPLOADS_PREFIX)) return null;

  const relativePath = decodeURIComponent(requestPath.slice(UPLOADS_PREFIX.length));
  if (!relativePath) return null;

  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  const uploadsRoot = path.resolve(getDeskRpgUploadsDir());
  const resolvedPath = path.resolve(path.join(uploadsRoot, ...segments));

  if (resolvedPath !== uploadsRoot && !resolvedPath.startsWith(`${uploadsRoot}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}
