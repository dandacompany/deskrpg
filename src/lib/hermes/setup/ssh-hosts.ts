/**
 * SSH managed by DeskRPG — a dedicated key, host keys confirmed by the admin, registered hosts.
 *
 * 2026-09-19 Dante decision (option A): DeskRPG creates `DESKRPG_HOME/ssh/id_ed25519` once and shows **only the
 * public key**. The admin appends one line to the target server's `authorized_keys`. The private key never leaves the
 * server and is not in the DB.
 * No passwords are accepted (same as Hermes Desktop).
 *
 * Host keys are **pinned after confirmation**. Desktop uses `StrictHostKeyChecking=accept-new` (auto-accept unseen
 * keys), but a web server has nobody in front of it to confirm at that moment — the registration screen shows the
 * fingerprint, and only when the admin-confirmed fingerprint matches a re-scan at registration time is it written to
 * `known_hosts`. Later connections use `StrictHostKeyChecking yes`.
 *
 * The container's HOME is `/nonexistent`, so every file ssh uses lives in this directory and the config points to it.
 * Every ssh call reads only this config via `-F <config>` — it never mixes in the server user's `~/.ssh/config`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { nullDevicePath } from "./platform";

/** The global known_hosts line of the managed config. Windows has no `/dev/null`. */
export function globalKnownHostsLine(platform: string): string {
  return `  GlobalKnownHostsFile ${nullDevicePath(platform)}`;
}

export type SshTarget = { host: string; port: number; user: string };
export type ManagedHost = SshTarget & {
  id: string;
  label: string;
  addedAt: string;
  fingerprints: string[];
};
export type ScannedKey = { type: string; blob: string; fingerprint: string };
export type ScanFn = (target: SshTarget) => Promise<string>;
export type KeygenFn = (keyPath: string, comment: string) => Promise<void>;

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const IPV6_RE = /^[0-9A-Fa-f:]{2,39}$/;
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;
const KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

/**
 * Validates the user-entered target. It is passed as an ssh argument, so every shape that could inject an option
 * is rejected.
 */
export function validateSshTarget(input: {
  host?: unknown;
  port?: unknown;
  user?: unknown;
}): SshTarget {
  const bad = () => new Error("setup_invalid_request");
  const host = typeof input.host === "string" ? input.host.trim().toLowerCase() : "";
  const user = typeof input.user === "string" ? input.user.trim() : "";
  const port =
    typeof input.port === "number"
      ? input.port
      : typeof input.port === "string" && /^\d{1,5}$/.test(input.port.trim())
        ? Number(input.port.trim())
        : NaN;
  if (!(HOST_RE.test(host) || (host.includes(":") && IPV6_RE.test(host)))) throw bad();
  // Link-local and cloud metadata addresses have no reason to be setup targets (same as gateway address validation).
  if (host.startsWith("169.254.") || host === "metadata.google.internal" || /^fe[89ab]/.test(host))
    throw bad();
  if (!USER_RE.test(user)) throw bad();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad();
  return { host, port, user };
}

/** Fingerprint in OpenSSH format: `SHA256:` + base64(sha256(key blob)), no padding. */
export function fingerprintOf(blob: string): string {
  const digest = createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** `ssh-keyscan` output → key list. Drops comments (`#`), unknown types and broken lines. Each key only once. */
export function parseKeyscan(output: string): ScannedKey[] {
  const seen = new Set<string>();
  const rows: ScannedKey[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [, type, blob] = trimmed.split(/\s+/);
    if (!type || !blob || !KEY_TYPES.has(type) || !/^[A-Za-z0-9+/=]+$/.test(blob)) continue;
    if (seen.has(blob)) continue;
    seen.add(blob);
    rows.push({ type, blob, fingerprint: fingerprintOf(blob) });
  }
  return rows;
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], shell: false });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > 65536) child.kill("SIGKILL");
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("ssh_unavailable"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || out) resolve(out);
      else reject(new Error("ssh_connection_failed"));
    });
  });
}

const defaultScan: ScanFn = async (target) => {
  // keyscan does not accept `--` — the host was validated above so it cannot start with `-`.
  const out = await run("ssh-keyscan", ["-T", "5", "-p", String(target.port), target.host], 15_000);
  return out;
};

const defaultKeygen: KeygenFn = async (keyPath, comment) => {
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath], 15_000);
};

async function writePrivate(file: string, text: string) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600);
}

export function createManagedSsh(
  deskrpgHome: string,
  deps: { scan?: ScanFn; keygen?: KeygenFn } = {},
) {
  const dir = path.join(deskrpgHome, "ssh");
  const keyPath = path.join(dir, "id_ed25519");
  const knownPath = path.join(dir, "known_hosts");
  const hostsPath = path.join(dir, "hosts.json");
  const configPath = path.join(dir, "config");
  const scan = deps.scan ?? defaultScan;
  const keygen = deps.keygen ?? defaultKeygen;

  async function ensureDir() {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }

  function list(): ManagedHost[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(hostsPath, "utf8"));
      return Array.isArray(parsed) ? (parsed as ManagedHost[]) : [];
    } catch {
      return [];
    }
  }

  /** hosts.json is the source of truth. config and known_hosts are rebuilt from validated values every time. */
  async function writeAll(hosts: ManagedHost[], keys: Map<string, ScannedKey[]>) {
    await ensureDir();
    await writePrivate(hostsPath, `${JSON.stringify(hosts, null, 2)}\n`);
    const blocks = hosts.map((h) =>
      [
        `Host ${h.id}`,
        `  HostName ${h.host}`,
        `  Port ${h.port}`,
        `  User ${h.user}`,
        `  IdentityFile ${keyPath}`,
        "  IdentitiesOnly yes",
        `  HostKeyAlias ${h.id}`,
        `  UserKnownHostsFile ${knownPath}`,
        globalKnownHostsLine(process.platform),
        "  StrictHostKeyChecking yes",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        "",
      ].join("\n"),
    );
    await writePrivate(configPath, blocks.join("\n"));
    const known: string[] = [];
    for (const h of hosts) {
      for (const k of keys.get(h.id) ?? []) known.push(`${h.id} ${k.type} ${k.blob}`);
    }
    await writePrivate(knownPath, known.length ? `${known.join("\n")}\n` : "");
  }

  async function readKnown(): Promise<Map<string, ScannedKey[]>> {
    const map = new Map<string, ScannedKey[]>();
    let text = "";
    try {
      text = await readFile(knownPath, "utf8");
    } catch {
      return map;
    }
    for (const line of text.split("\n")) {
      const [alias, type, blob] = line.trim().split(/\s+/);
      if (!alias || !type || !blob) continue;
      const rows = map.get(alias) ?? [];
      rows.push({ type, blob, fingerprint: fingerprintOf(blob) });
      map.set(alias, rows);
    }
    return map;
  }

  return {
    configPath,
    list,
    /** For a managed host, `-F <managed config>` — the legacy env-var alias uses the server's ssh config as-is. */
    configArgs(hostId: string): string[] {
      return existsSync(configPath) && list().some((h) => h.id === hostId)
        ? ["-F", configPath]
        : [];
    },
    /** The dedicated key's public key. Created if missing. The private key is never returned. */
    async publicKey(): Promise<string> {
      await ensureDir();
      if (!existsSync(keyPath)) await keygen(keyPath, `deskrpg@${os.hostname()}`);
      await chmod(keyPath, 0o600).catch(() => {});
      return (await readFile(`${keyPath}.pub`, "utf8")).trim();
    },
    async scan(input: SshTarget): Promise<ScannedKey[]> {
      const target = validateSshTarget(input);
      const rows = parseKeyscan(await scan(target));
      if (!rows.length) throw new Error("ssh_connection_failed");
      return rows;
    },
    /**
     * Registers with the confirmed fingerprints. Re-scans at registration time and rejects if it differs from the
     * confirmed set — if the key changed while the screen was being viewed, it is not what the admin confirmed.
     */
    async register(input: SshTarget, confirmed: string[]): Promise<ManagedHost> {
      const target = validateSshTarget(input);
      const rows = parseKeyscan(await scan(target));
      const now = new Set(rows.map((r) => r.fingerprint));
      const want = new Set(confirmed);
      if (!rows.length || now.size !== want.size || [...now].some((f) => !want.has(f)))
        throw new Error("ssh_host_key_failed");
      const id = `h-${createHash("sha256")
        .update(`${target.user}@${target.host}:${target.port}`)
        .digest("hex")
        .slice(0, 10)}`;
      const host: ManagedHost = {
        ...target,
        id,
        label: `${target.user}@${target.host}${target.port === 22 ? "" : `:${target.port}`}`,
        addedAt: new Date().toISOString(),
        fingerprints: rows.map((r) => r.fingerprint),
      };
      const keys = await readKnown();
      keys.set(id, rows);
      await writeAll([...list().filter((h) => h.id !== id), host], keys);
      return host;
    },
    async remove(hostId: string): Promise<void> {
      const keys = await readKnown();
      keys.delete(hostId);
      await writeAll(
        list().filter((h) => h.id !== hostId),
        keys,
      );
    },
  };
}

let singleton: ReturnType<typeof createManagedSsh> | null = null;
/** The managed SSH the server uses. Kept in `DESKRPG_HOME` (a volume in Docker) so the key survives redeploys. */
export function managedSsh() {
  singleton ??= createManagedSsh(process.env.DESKRPG_HOME || path.join(os.homedir(), ".deskrpg"));
  return singleton;
}
