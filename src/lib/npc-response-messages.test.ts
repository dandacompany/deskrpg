import test from "node:test";
import assert from "node:assert/strict";

import {
  getNpcResponseMessageKey,
  resolveNpcResponseChunk,
  type NpcResponseMessageCode,
} from "./npc-response-messages";

// This is an exhaustive list — the type is `Record<NpcResponseMessageCode, string>`, so
// adding a code without listing it here fails compilation. It used to list only 5 of 12
// codes; the type claimed "exhaustive" but that only surfaced as a tsc error that nobody
// looked at.
const TEST_CODES: Record<NpcResponseMessageCode, string> = {
  no_agent: "npc.noAgent",
  gateway_not_connected: "npc.gatewayNotConnected",
  gateway_error: "npc.gatewayError",
  gateway_unreachable: "npc.gatewayUnreachable",
  gateway_auth_failed: "npc.gatewayAuthFailed",
  gateway_timeout: "npc.gatewayTimeout",
  gateway_unknown_error: "npc.gatewayUnknownError",
  unsupported_adapter: "npc.unsupportedAdapter",
  wait_before_sending: "npc.waitBeforeSending",
  npc_not_found: "npc.notFound",
  unsupported_file_type: "npc.unsupportedFileType",
  file_too_large: "npc.fileTooLarge",
  too_many_files: "npc.tooManyFiles",
  npc_unbound: "npc.unbound",
  hermes_image_unsupported: "npc.hermesImageUnsupported",
};

test("npc response message codes map to stable translation keys", () => {
  for (const [code, key] of Object.entries(TEST_CODES)) {
    assert.equal(getNpcResponseMessageKey(code as NpcResponseMessageCode), key);
  }
});

test("resolveNpcResponseChunk localizes system message codes", () => {
  const calls: Array<{ key: string; params?: Record<string, string | number> }> = [];
  const result = resolveNpcResponseChunk(
    {
      chunk: "",
      messageCode: "gateway_error",
    },
    (key, params) => {
      calls.push({ key, params });
      return `translated:${key}`;
    },
  );

  assert.equal(result, "translated:npc.gatewayError");
  assert.deepEqual(calls, [{ key: "npc.gatewayError", params: undefined }]);
});

test("resolveNpcResponseChunk preserves streamed text when no system message code exists", () => {
  const result = resolveNpcResponseChunk(
    {
      chunk: "hello",
    },
    () => "should-not-be-used",
  );

  assert.equal(result, "hello");
});

// Registering a code without a translation shows the user the raw key string or an empty
// bubble. The error-code side had this guard, but NPC system messages did not.
test("every registered NPC system message code has a translation in all 4 locales", async () => {
  const [ko, en, ja, zh] = await Promise.all([
    import("./i18n/locales/ko"),
    import("./i18n/locales/en"),
    import("./i18n/locales/ja"),
    import("./i18n/locales/zh"),
  ]);
  const locales: Array<[string, Record<string, string>]> = [
    ["ko", ko.default],
    ["en", en.default],
    ["ja", ja.default],
    ["zh", zh.default],
  ];
  const missing: string[] = [];
  for (const key of Object.values(TEST_CODES)) {
    for (const [lang, dict] of locales) {
      if (!dict[key]) missing.push(`${lang}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], `번역이 없는 NPC 메시지 코드:\n  ${missing.join("\n  ")}`);
});
