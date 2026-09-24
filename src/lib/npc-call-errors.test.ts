import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ko from "./i18n/locales/ko";
import { isNpcCallRejected, npcCallErrorKey, NPC_CALL_REJECTIONS } from "./npc-call-errors";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("every rejection reason has a user-visible message", () => {
  for (const reason of NPC_CALL_REJECTIONS) {
    const key = npcCallErrorKey(reason);
    assert.ok(key in ko, `${reason} 의 문구(${key})가 로케일에 없다`);
    assert.ok((ko as Record<string, string>)[key].trim().length > 0, `${reason} 문구가 비어 있다`);
  }
});

test("each reason uses a distinct message — what blocked it must be distinguishable", () => {
  const keys = NPC_CALL_REJECTIONS.filter((r) => r !== "unavailable").map(npcCallErrorKey);
  assert.equal(new Set(keys).size, keys.length);
});

test("an unknown reason does not leak as an empty message", () => {
  assert.equal(npcCallErrorKey("something_new"), npcCallErrorKey("unavailable"));
  assert.equal(npcCallErrorKey(undefined), npcCallErrorKey("unavailable"));
});

test("treats a missing ack or a not-ok ack as a rejection", () => {
  assert.equal(isNpcCallRejected({ ok: true }), false);
  assert.equal(isNpcCallRejected({ ok: false, error: "already_claimed" }), true);
  assert.equal(isNpcCallRejected(undefined), true, "타임아웃도 실패다");
  assert.equal(isNpcCallRejected(null), true);
});

// If this list drifts from the reasons the server can actually return, a new reason
// silently falls back to the generic message. Reads the error string the `npc:call`
// handler returns directly and cross-checks it.
test("every reason the server returns from npc:call is in the list", () => {
  const source = readFileSync(path.join(repoRoot, "src/server/npc-coordination.ts"), "utf8");
  const handler = source.slice(
    source.indexOf('handle("npc:call"'),
    source.indexOf('handle("npc:return-home"'),
  );
  assert.ok(handler.length > 0, "npc:call 핸들러를 찾지 못했다");
  const reasons = [...handler.matchAll(/error:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(reasons.length > 0, "핸들러에서 거절 사유를 추출하지 못했다");
  for (const reason of reasons) {
    assert.ok(
      (NPC_CALL_REJECTIONS as readonly string[]).includes(reason),
      `서버의 거절 사유 "${reason}" 에 사용자 문구가 없다 — npc-call-errors.ts 에 추가하세요.`,
    );
  }
});

// Even with a rejection message defined, it never arrives if the ack isn't received —
// that was, in fact, the bug behind this card. Checks that every client `npc:call` emit
// passes a callback (the third argument = ack).
test("every client npc:call receives an ack", () => {
  const files = ["src/app/game/GamePageClient.tsx", "src/game/simulation/office-simulation.ts"];
  const missing: string[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    for (const match of source.matchAll(/emit\(\s*\n?\s*"npc:call"/g)) {
      // Cuts out the argument list by counting balanced parens in the emit call.
      let depth = 0;
      let end = match.index!;
      for (let i = source.indexOf("(", match.index!); i < source.length; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const call = source.slice(match.index!, end + 1);
      if (!/=>|function\s*\(/.test(call)) missing.push(`${file}: ${call.slice(0, 60)}…`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `ack 없이 npc:call 을 보내는 곳이 있습니다 — 서버가 거절해도 사용자는 알 수 없습니다:\n${missing.join("\n")}`,
  );
});
