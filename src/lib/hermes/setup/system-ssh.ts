/**
 * System SSH hosts — the same approach as Hermes Desktop.
 *
 * Uses the `~/.ssh/config`, ssh-agent and key files of the user running the DeskRPG server as-is. No dedicated key
 * is created, and host keys use `StrictHostKeyChecking=accept-new` like Desktop (unseen keys are recorded, changed
 * keys are rejected).
 * The target is a config alias or hostname; user, port and key path are optional. With `BatchMode=yes` it never
 * asks for a password or passphrase — such keys must be loaded into ssh-agent first.
 *
 * The availability condition is also the same as Desktop: when `ssh` exists and the server user has `~/.ssh`.
 * Where that's missing, like in a container, this approach hides and only DeskRPG's own key registration
 * (ssh-hosts.ts) remains.
 *
 * The registration list lives in `DESKRPG_HOME/ssh/system-hosts.json` (0600). Key contents are stored nowhere.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type SystemHost = {
  id: string;
  label: string;
  target: string;
  user?: string;
  port?: number;
  keyPath?: string;
  addedAt: string;
};

const TARGET_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,251}[A-Za-z0-9])?$/;
const IPV6_RE = /^[0-9A-Fa-f:]{2,39}$/;
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * `Host` aliases in `~/.ssh/config` — wildcard and negated patterns are excluded (same as Desktop's ssh-config.ts).
 */
export function parseSshConfigHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*host\s+(.+)$/i.exec(raw);
    if (!m) continue;
    for (const pattern of m[1].trim().split(/\s+/)) {
      if (!pattern || /[*?!]/.test(pattern) || !TARGET_RE.test(pattern)) continue;
      if (!hosts.includes(pattern)) hosts.push(pattern);
    }
  }
  return hosts;
}

/** Files referenced by `Include`. Relative paths are based on `~/.ssh`; only `*` in the last segment is expanded.
 * Read-only. */
function includeTargets(text: string, sshDir: string, home: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*include\s+(.+)$/i.exec(raw);
    if (!m) continue;
    for (let spec of m[1].trim().split(/\s+/)) {
      if (spec.startsWith("~/")) spec = path.join(home, spec.slice(2));
      else if (!path.isAbsolute(spec)) spec = path.join(sshDir, spec);
      const dir = path.dirname(spec);
      const base = path.basename(spec);
      if (!base.includes("*")) {
        out.push(spec);
        continue;
      }
      const re = new RegExp(
        "^" + base.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*") + "$",
      );
      try {
        for (const name of readdirSync(dir).sort())
          if (re.test(name)) out.push(path.join(dir, name));
      } catch {
        /* ssh also skips a missing Include */
      }
    }
  }
  return out;
}

export function readSshConfigHosts(home = os.homedir()): string[] {
  const sshDir = path.join(home, ".ssh");
  const seen = new Set<string>();
  const hosts: string[] = [];
  const visit = (file: string, depth: number) => {
    if (depth > 8 || seen.has(file) || seen.size > 64) return;
    seen.add(file);
    let text = "";
    try {
      if (!statSync(file).isFile()) return;
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const h of parseSshConfigHosts(text)) if (!hosts.includes(h)) hosts.push(h);
    for (const inc of includeTargets(text, sshDir, home)) visit(inc, depth + 1);
  };
  visit(path.join(sshDir, "config"), 0);
  return hosts.slice(0, 256);
}

/** Whether the Desktop approach is usable — the server user needs `~/.ssh` for agent, keys and known_hosts. */
export function systemSshAvailable(home = os.homedir()): boolean {
  try {
    return statSync(path.join(home, ".ssh")).isDirectory();
  } catch {
    return false;
  }
}

export function validateSystemTarget(
  input: { target?: unknown; user?: unknown; port?: unknown; keyPath?: unknown },
  home = os.homedir(),
): Omit<SystemHost, "id" | "label" | "addedAt"> {
  const bad = () => new Error("setup_invalid_request");
  const target = typeof input.target === "string" ? input.target.trim() : "";
  if (!(TARGET_RE.test(target) || (target.includes(":") && IPV6_RE.test(target)))) throw bad();
  if (target.startsWith("169.254.") || target === "metadata.google.internal") throw bad();
  const out: Omit<SystemHost, "id" | "label" | "addedAt"> = { target };
  const user = typeof input.user === "string" ? input.user.trim() : "";
  if (user) {
    if (!USER_RE.test(user)) throw bad();
    out.user = user;
  }
  const portRaw = typeof input.port === "number" ? String(input.port) : input.port;
  if (typeof portRaw === "string" && portRaw.trim()) {
    if (!/^\d{1,5}$/.test(portRaw.trim())) throw bad();
    const port = Number(portRaw.trim());
    if (port < 1 || port > 65535) throw bad();
    out.port = port;
  }
  const keyRaw = typeof input.keyPath === "string" ? input.keyPath.trim() : "";
  if (keyRaw) {
    if (keyRaw.length > 512 || CONTROL.test(keyRaw) || keyRaw.startsWith("-")) throw bad();
    const expanded = keyRaw.startsWith("~/") ? path.join(home, keyRaw.slice(2)) : keyRaw;
    if (!path.isAbsolute(expanded)) throw bad();
    // Contents aren't read; only whether the file exists — so a typo isn't chased as an "auth failure".
    try {
      if (!statSync(expanded).isFile()) throw new Error("ssh_key_not_found");
    } catch {
      throw new Error("ssh_key_not_found");
    }
    out.keyPath = path.normalize(expanded);
  }
  return out;
}

export function labelOf(host: Omit<SystemHost, "id" | "label" | "addedAt">): string {
  return `${host.user ? `${host.user}@` : ""}${host.target}${host.port ? `:${host.port}` : ""}`;
}

/** Arguments when calling via system SSH — reads the server user's config as-is, without `-F`. */
export function systemSshArgs(host: SystemHost): string[] {
  return [
    ...(host.port ? ["-p", String(host.port)] : []),
    ...(host.user ? ["-l", host.user] : []),
    ...(host.keyPath ? ["-i", host.keyPath] : []),
  ];
}

export function createSystemSsh(deskrpgHome: string) {
  const dir = path.join(deskrpgHome, "ssh");
  const file = path.join(dir, "system-hosts.json");
  function list(): SystemHost[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? (parsed as SystemHost[]) : [];
    } catch {
      return [];
    }
  }
  async function write(hosts: SystemHost[]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(hosts, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
    await chmod(file, 0o600);
  }
  return {
    list,
    get(id: string): SystemHost | undefined {
      return existsSync(file) ? list().find((h) => h.id === id) : undefined;
    },
    async add(target: Omit<SystemHost, "id" | "label" | "addedAt">): Promise<SystemHost> {
      const id = `s-${createHash("sha256")
        .update(
          JSON.stringify([
            target.target,
            target.user ?? "",
            target.port ?? 0,
            target.keyPath ?? "",
          ]),
        )
        .digest("hex")
        .slice(0, 10)}`;
      const host: SystemHost = {
        ...target,
        id,
        label: labelOf(target),
        addedAt: new Date().toISOString(),
      };
      await write([...list().filter((h) => h.id !== id), host]);
      return host;
    },
    async remove(id: string) {
      await write(list().filter((h) => h.id !== id));
    },
  };
}

let singleton: ReturnType<typeof createSystemSsh> | null = null;
export function systemSsh() {
  singleton ??= createSystemSsh(process.env.DESKRPG_HOME || path.join(os.homedir(), ".deskrpg"));
  return singleton;
}
