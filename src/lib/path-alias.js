/**
 * Resolves `@/...` path aliases at runtime.
 *
 * tsx resolves this alias via tsconfig's `paths`, but **that mapping is not applied to
 * files inside `node_modules`** (the resolver's standard behavior). Installed via
 * `npm i -g deskrpg`, the server source ends up under `.../node_modules/deskrpg/src/**`,
 * so the moment the socket server first calls `@/db`, it dies with
 * `Cannot find module '@/db'`.
 *
 * Measured (2026-09-15): both the 2026.9.18 and 2026.9.19 releases failed to start with
 * this exact error via `deskrpg start`. Moving the same set of files out of
 * `node_modules` made it start fine — it's an install-location problem, not a code
 * problem. The Docker image unpacks to `/app` so it was unaffected, which is why this
 * defect stayed quietly alive only on the npm path.
 *
 * So we do the resolution ourselves. Only requests starting with `@/` are redirected to
 * the package's `src/`; everything else is left untouched.
 */
const Module = require("node:module");
const path = require("node:path");

const PREFIX = "@/";

function installPathAlias(rootDir) {
  const srcDir = path.join(rootDir, "src");
  const original = Module._resolveFilename;
  if (original.__deskrpgAlias) return;

  function resolveFilename(request, parent, isMain, options) {
    if (typeof request === "string" && request.startsWith(PREFIX)) {
      const mapped = path.join(srcDir, request.slice(PREFIX.length));
      try {
        return original.call(this, mapped, parent, isMain, options);
      } catch {
        // If the mapping fails, fall through with the original request as-is — we don't manufacture a new error.
      }
    }
    return original.call(this, request, parent, isMain, options);
  }

  resolveFilename.__deskrpgAlias = true;
  Module._resolveFilename = resolveFilename;
}

module.exports = { installPathAlias };
