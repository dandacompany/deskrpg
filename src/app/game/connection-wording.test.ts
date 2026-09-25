/**
 * While the socket is down, SocketConnectionNotice stays on screen and says it reconnects on
 * its own. Anything else shown in that window must agree with it: no second toast about the same
 * outage, and no "refresh the page" advice that contradicts the automatic reconnect.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import en from "@/lib/i18n/locales/en";
import ja from "@/lib/i18n/locales/ja";
import ko from "@/lib/i18n/locales/ko";
import zh from "@/lib/i18n/locales/zh";

const LOCALES: Record<string, Record<string, string>> = { ko, en, ja, zh };
const REFRESH: Record<string, RegExp> = {
  ko: /새로고침/,
  en: /refresh|reload/i,
  ja: /再読み込み|リロード|更新して/,
  zh: /刷新/,
};
/** Messages shown while the connection is down. */
const OUTAGE_KEYS = [
  "game.socketOfflinePersistent",
  "game.npcChatDisconnected",
  "game.channelChatDisconnected",
];

test("messages shown during an outage never tell the user to refresh", () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    for (const key of OUTAGE_KEYS) {
      assert.ok(messages[key], `${locale} is missing ${key}`);
      assert.doesNotMatch(messages[key], REFRESH[locale], `${locale} ${key}`);
    }
  }
});

/** The body of `socketInstance.on("<event>", …)` up to the next `socketInstance.on(`. */
function handlerBody(source: string, event: string): string {
  const start = source.indexOf(`socketInstance.on("${event}"`);
  assert.ok(start >= 0, `no ${event} handler`);
  const end = source.indexOf("socketInstance.on(", start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

test("disconnect and connect_error leave the outage to the persistent notice, with no toast", () => {
  const source = readFileSync(path.join(process.cwd(), "src/app/game/GamePageClient.tsx"), "utf8");
  for (const event of ["disconnect", "connect_error"]) {
    assert.doesNotMatch(handlerBody(source, event), /showToastNotification\(/, event);
  }
});
