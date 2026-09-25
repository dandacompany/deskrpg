import type { McpServerInput } from "@/lib/hermes/plugin-client-types";

type Raw = {
  command?: unknown;
  args?: unknown;
  url?: unknown;
  env?: unknown;
  headers?: unknown;
  auth?: unknown;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const isEntry = (v: unknown): v is Raw =>
  isObject(v) && (typeof v.url === "string" || typeof v.command === "string");

/**
 * Fills the add form from a pasted MCP JSON snippet: `{"name":{…}}`, `{"mcpServers":{"name":{…}}}`,
 * or a flat `{"name":"…","command"|"url":…}`. Only the first server is read. Values under `env`
 * and header values are dropped on purpose — secrets are entered separately and never sit in the
 * form state.
 */
export function parseMcpJson(text: string): { ok: true; input: McpServerInput } | { ok: false } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!isObject(data)) return { ok: false };
  let name: string | undefined;
  let raw: Raw | undefined;
  const flatName = data.name;
  if (typeof flatName === "string" && isEntry(data)) {
    name = flatName;
    raw = data;
  } else {
    const servers = isObject(data.mcpServers) ? data.mcpServers : data;
    const found = Object.entries(servers).find(([, v]) => isEntry(v));
    if (found) [name, raw] = found as [string, Raw];
  }
  if (!name || !raw) return { ok: false };
  if (typeof raw.url === "string") {
    const bearer = isObject(raw.headers) && "Authorization" in raw.headers;
    const auth = raw.auth === "oauth" ? "oauth" : bearer ? "bearer" : "none";
    return { ok: true, input: { name, transport: "http", url: raw.url, auth } };
  }
  const args = Array.isArray(raw.args)
    ? raw.args.filter((a): a is string => typeof a === "string")
    : [];
  const env = isObject(raw.env)
    ? Object.fromEntries(Object.keys(raw.env).map((k) => [k, ""]))
    : undefined;
  return {
    ok: true,
    input: {
      name,
      transport: "stdio",
      command: raw.command as string,
      args,
      ...(env ? { env } : {}),
      auth: env ? "env" : "none",
    },
  };
}
