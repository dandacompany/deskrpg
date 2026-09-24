/**
 * Discovers profiles in a local Hermes installation.
 *
 * The Hermes API Server has no endpoint listing profiles (spec §2.1), and the dashboard's
 * profiles.list RPC has no auth path for external servers (§2.2). The filesystem is the path
 * available only when the app and Hermes are on the same machine.
 *
 * The filesystem is pushed outside the pure functions — if tests depended on the real home directory,
 * results would differ per person running them.
 */

import { PROFILE_NAME_RE } from "./profile-name";

/** Minimum length Hermes requires for a profile key (hermes_cli.auth.has_usable_secret). */
const MIN_TOKEN_LENGTH = 16;

export type ProfileFs = {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string, enc: "utf8"): string;
  statIsDirectory(p: string): boolean;
};

export type LocalProfile = { name: string; hasToken: boolean };

/**
 * Location of the profiles directory. Follows the _get_profiles_root rule in hermes_cli/profiles.py —
 * "In Docker/custom deployments where HERMES_HOME points outside ~/.hermes,
 *  profiles live under HERMES_HOME/profiles/ so they persist on the mounted volume."
 */
export function resolveProfilesRoot(
  env: Record<string, string | undefined>,
  homedir: string,
): string {
  const defaultHome = `${homedir}/.hermes`;
  const override = (env.HERMES_HOME || "").trim();
  if (!override || override === defaultHome || override.startsWith(defaultHome + "/")) {
    // HERMES_HOME is unset or points inside ~/.hermes (which may itself be a profile).
    // Either way the profiles root is ~/.hermes/profiles.
    return `${defaultHome}/profiles`;
  }
  return `${override.replace(/\/+$/, "")}/profiles`;
}

function parseEnvValue(contents: string, key: string): string | null {
  let found: string | null = null;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(`${key}=`)) continue;
    let value = line.slice(key.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // Last definition wins — the key may have been appended several times.
    found = value;
  }
  return found || null;
}

/**
 * The profile's API_SERVER_KEY. Named profiles use their own .env; default uses the root's parent .env.
 * Measured: ~/.hermes/profiles/default/ has no .env — default's home is ~/.hermes itself.
 */
export function readProfileToken(root: string, name: string, fs: ProfileFs): string | null {
  // Defence in depth: `name` here is not guaranteed to have passed PROFILE_NAME_RE —
  // this function's own callers may not validate it (Task 4 review, Critical 1: a
  // registration batch endpoint fed unvalidated names straight into this path
  // concatenation, letting "../../../../srv/otherapp" read an arbitrary .env off the
  // box). "default" is the one legitimate exception the branch below already special-
  // cases. Do not delete this as "redundant with PROFILE_NAME_RE at the call site" —
  // a future caller may skip that check the way this one did.
  if (name !== "default" && !PROFILE_NAME_RE.test(name)) return null;
  const envPath =
    name === "default" ? `${root.replace(/\/profiles$/, "")}/.env` : `${root}/${name}/.env`;
  if (!fs.existsSync(envPath)) return null;
  let contents: string;
  try {
    contents = fs.readFileSync(envPath, "utf8");
  } catch {
    return null;
  }
  return parseEnvValue(contents, "API_SERVER_KEY");
}

/**
 * Treats subdirectories that have a config.yaml as profile candidates.
 *
 * Don't decide from this list alone. In practice ~/.hermes/profiles/ also has non-agent directories
 * like acestep_output with the same layout. The caller overlays gateway
 * probes to make the final call (spec §6.1).
 */
export function listLocalProfiles(root: string, fs: ProfileFs): LocalProfile[] {
  if (!fs.existsSync(root)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: LocalProfile[] = [];
  for (const name of entries.sort()) {
    if (!PROFILE_NAME_RE.test(name)) continue;
    const dir = `${root}/${name}`;
    if (!fs.statIsDirectory(dir)) continue;
    if (!fs.existsSync(`${dir}/config.yaml`)) continue;
    const token = readProfileToken(root, name, fs);
    out.push({ name, hasToken: !!token && token.length >= MIN_TOKEN_LENGTH });
  }
  return out;
}

/** Default implementation using the real filesystem. Call only from server code. */
export function nodeProfileFs(): ProfileFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  return {
    existsSync: (p) => nodeFs.existsSync(p),
    readdirSync: (p) => nodeFs.readdirSync(p),
    readFileSync: (p, enc) => nodeFs.readFileSync(p, enc),
    statIsDirectory: (p) => {
      try {
        return nodeFs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
  };
}
