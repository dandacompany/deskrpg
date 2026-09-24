import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Hard gate 2: decrypted gateway and profile tokens are not put in response bodies.
 *
 * Measured on 2026-09-15, three places broke this gate —
 * `GET /api/channels/:id/gateway`, `GET /api/gateways/:id` and `PATCH /api/gateways/:id`
 * returned `token: decryptGatewayToken(...)` as is. Even restricted to owners it
 * leaks into browser memory, proxy logs and extensions.
 *
 * This test forbids the shape "put a token key in a response object" in route sources. It does not block
 * the server decrypting to call Hermes (variables, function arguments).
 */
const API_DIR = path.join(process.cwd(), "src", "app", "api");

/**
 * Catch every line that puts a decrypted value into a `token:` field.
 *
 * It does not distinguish whether the response object is written directly inside `NextResponse.json(...)` or built and
 * returned by a helper — the place that actually leaked on 2026-09-15 (`buildResponseGatewayConfig`) was exactly a helper.
 *
 * Decrypting to pass **as a function argument** so the server can call Hermes is normal, so such lines are
 * explicitly exempted with a `deskrpg-allow-token-arg` comment right above them. Exemptions must be visible.
 */
const ALLOW_MARKER = "deskrpg-allow-token-arg";

function findDecryptedTokenFields(source: string): number[] {
  const lines = source.split("\n");
  const hits: number[] = [];
  lines.forEach((line, index) => {
    if (!/(^|[^A-Za-z])token:/.test(line)) return;
    // The formatter splits `token:` and its value across lines — treat the next two lines as one statement.
    const statement = lines.slice(index, index + 3).join("\n");
    if (!statement.includes("decryptGatewayToken")) return;
    const previous = lines.slice(Math.max(0, index - 3), index).join("\n");
    if (previous.includes(ALLOW_MARKER) || statement.includes(ALLOW_MARKER)) return;
    hits.push(index + 1);
  });
  return hits;
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield full;
  }
}

test("API routes do not put decrypted gateway tokens in responses", () => {
  const offenders: string[] = [];
  for (const file of walk(API_DIR)) {
    for (const line of findDecryptedTokenFields(fs.readFileSync(file, "utf8"))) {
      offenders.push(`${path.relative(process.cwd(), file)}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `복호화된 토큰을 응답 필드로 내보내는 곳: ${offenders.join(", ")}\n` +
      "저장 여부만 필요하다면 hasToken 같은 불리언으로 바꾸세요.",
  );
});
