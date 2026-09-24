import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapPluginFailure, pluginUpgradeRequired } from "./plugin-errors";
import { supportsSwarm, swarmGate } from "./plugin-capability";
import type { PluginInfo } from "./deskrpg-plugin-types";

describe("mapPluginFailure", () => {
  it("2xx is not a failure", () => {
    assert.equal(mapPluginFailure({ status: 200, body: { body: "hi" } }), null);
  });

  it("unreadable blocks the editor even with 200", () => {
    // If an empty editor opens, the user wipes someone else's persona with the save button.
    const got = mapPluginFailure({
      status: 200,
      body: { body: null, isDefaultTemplate: null, revision: null, unreadable: true },
    });
    assert.ok(got);
    assert.equal(got.code, "unreadable");
    assert.equal(got.blocksEditor, true);
  });

  it("409 identity_unreadable says nothing was written", () => {
    const got = mapPluginFailure({
      status: 409,
      body: { error: "identity_unreadable", reason: "SOUL.md 을 읽을 수 없다: UnicodeDecodeError" },
    });
    assert.ok(got);
    assert.equal(got.code, "identity_unreadable");
    assert.equal(got.blocksEditor, true);
    assert.match(got.message, /UnicodeDecodeError/);
  });

  it("409 config_unreadable follows the same convention", () => {
    const got = mapPluginFailure({
      status: 409,
      body: { error: "config_unreadable", reason: "기존 model 키가 매핑이 아니다" },
    });
    assert.ok(got);
    assert.equal(got.code, "config_unreadable");
    assert.equal(got.blocksEditor, true);
  });

  it("409 profile_has_service shows the shell command as-is", () => {
    const got = mapPluginFailure({
      status: 409,
      body: {
        error: "profile_has_service",
        name: "noah",
        unit: "hermes-gateway-noah",
        reason:
          "프로필 'noah' 은 자기 서비스(hermes-gateway-noah)를 갖고 있어 여기서 지울 수 없습니다. 셸에서 정리하세요: hermes profile delete noah",
      },
    });
    assert.ok(got);
    assert.equal(got.code, "profile_has_service");
    assert.equal(got.showsShellCommand, "hermes profile delete noah");
  });

  it("409 revision_conflict means re-read", () => {
    const got = mapPluginFailure({ status: 409, body: { error: "revision_conflict" } });
    assert.ok(got);
    assert.equal(got.code, "revision_conflict");
    assert.equal(got.blocksEditor, false);
  });

  it("409 already_exists is a name collision", () => {
    const got = mapPluginFailure({ status: 409, body: { error: "already_exists", name: "noah" } });
    assert.ok(got);
    assert.equal(got.code, "already_exists");
  });

  it("an unknown error does not lose its code", () => {
    const got = mapPluginFailure({ status: 500, body: {} });
    assert.ok(got);
    assert.equal(got.code, "plugin_error");
  });

  it("does not throw even when the body is not an object", () => {
    const got = mapPluginFailure({ status: 400, body: "bad request" });
    assert.ok(got);
    assert.equal(got.code, "plugin_error");
  });
});

// I-2: structured fields besides error/reason (currentRevision·name·unit …) are needed by the UI
// but are currently dropped. They must be carried over to details for re-read, merge and name-collision guidance.
describe("mapPluginFailure — details (I-2 recovery)", () => {
  it("revision_conflict's currentRevision is needed for re-reading — it stays in details", () => {
    const got = mapPluginFailure({
      status: 409,
      body: { error: "revision_conflict", currentRevision: "zzz" },
    });
    assert.ok(got);
    assert.equal(got.details.currentRevision, "zzz");
  });

  it("already_exists's name must stay in details to build the 'already exists' sentence", () => {
    const got = mapPluginFailure({ status: 409, body: { error: "already_exists", name: "noah" } });
    assert.ok(got);
    assert.equal(got.details.name, "noah");
  });

  it("profile_has_service's unit also stays in details", () => {
    const got = mapPluginFailure({
      status: 409,
      body: {
        error: "profile_has_service",
        name: "noah",
        unit: "hermes-gateway-noah",
        reason:
          "프로필 'noah' 은 자기 서비스(hermes-gateway-noah)를 갖고 있어 여기서 지울 수 없습니다. 셸에서 정리하세요: hermes profile delete noah",
      },
    });
    assert.ok(got);
    assert.equal(got.details.unit, "hermes-gateway-noah");
    assert.equal(got.details.name, "noah");
  });

  it("details is an empty object even without code/message — never undefined", () => {
    const got = mapPluginFailure({ status: 500, body: {} });
    assert.ok(got);
    assert.deepEqual(got.details, {});
  });
});

// M-3: shell command extraction attaches based only on the sentence's ending shape, regardless of code. A command
// button must not appear for an unrelated code that happens to end the same way — narrow it with a whitelist.
describe("mapPluginFailure — showsShellCommand only for whitelisted codes (M-3)", () => {
  it("profile_has_service shows the shell command (existing behavior kept)", () => {
    const got = mapPluginFailure({
      status: 409,
      body: {
        error: "profile_has_service",
        reason: "정리하세요: hermes profile delete noah",
      },
    });
    assert.ok(got);
    assert.equal(got.showsShellCommand, "hermes profile delete noah");
  });

  it("does not show a shell command even if a revision_conflict description happens to end the same way", () => {
    const got = mapPluginFailure({
      status: 409,
      body: {
        error: "revision_conflict",
        reason: "다시 시도하기 전에 참고: hermes profile delete noah",
      },
    });
    assert.ok(got);
    assert.equal(got.showsShellCommand, null);
  });
});

// M-4: unreachable and 5xx (plugin_error) both mean "the server could not respond", yet
// blocksEditor was opposite. If the editor opens on 5xx, it fails again at save time.
describe("mapPluginFailure — 5xx also blocks the editor (M-4)", () => {
  it("500 is blocksEditor: true", () => {
    const got = mapPluginFailure({ status: 500, body: {} });
    assert.ok(got);
    assert.equal(got.blocksEditor, true);
  });

  it("503 is also blocksEditor: true", () => {
    const got = mapPluginFailure({ status: 503, body: {} });
    assert.ok(got);
    assert.equal(got.blocksEditor, true);
  });

  it("4xx is still blocksEditor: false unless it is a named code (retryable user input error)", () => {
    const got = mapPluginFailure({ status: 400, body: "bad request" });
    assert.ok(got);
    assert.equal(got.blocksEditor, false);
  });
});

describe("profile_has_service guidance", () => {
  it("the profile name goes into the shell command as-is", () => {
    // The user must be able to copy-paste and run it right away. If we reassemble the name
    // ourselves it can go wrong on encoding/whitespace, so use the string the plugin gave.
    const got = mapPluginFailure({
      status: 409,
      body: {
        error: "profile_has_service",
        unit: "hermes-gateway-my-bot",
        reason:
          "프로필 'my-bot' 은 자기 서비스(hermes-gateway-my-bot)를 갖고 있어 여기서 지울 수 없습니다. 셸에서 정리하세요: hermes profile delete my-bot",
      },
    });
    assert.ok(got);
    assert.equal(got.showsShellCommand, "hermes profile delete my-bot");
  });
});

describe("three shapes of record.error (fix round 2 — live measurement, MiniPC gateway, Hermes v0.21.0)", () => {
  it("404 — when error is a plain sentence, the sentence does not leak into the code slot", () => {
    // Exactly as measured: { "error": "Unknown or unconfigured profile" }
    const got = mapPluginFailure({
      status: 404,
      body: { error: "Unknown or unconfigured profile" },
    });
    assert.ok(got);
    assert.equal(
      got.code,
      "upstream_error",
      "문장은 wizard-error-codes 사전에 없는 값이라 코드로 쓰면 안 된다",
    );
    assert.equal(
      got.message,
      "Unknown or unconfigured profile",
      "문장 자체는 잃지 않고 message 에 보존한다",
    );
  });

  it("401 — when error is an object, extract the real code inside", () => {
    // Exactly as measured: { "error": { "message": "...", "type": "gateway_auth_error",
    //                            "code": "gateway_auth_failed" } }
    const got = mapPluginFailure({
      status: 401,
      body: {
        error: {
          message: "Invalid gateway API key (API_SERVER_KEY)",
          type: "gateway_auth_error",
          code: "gateway_auth_failed",
        },
      },
    });
    assert.ok(got);
    assert.equal(got.code, "gateway_auth_failed", "plugin_error 로 뭉개면 진짜 원인을 잃는다");
    assert.equal(got.message, "Invalid gateway API key (API_SERVER_KEY)");
  });

  it("409 — when error is a short code string, use it as the code as before", () => {
    // Exactly as measured: { "error": "config_unreadable", "reason": "..." } — our plugin's shape.
    const got = mapPluginFailure({
      status: 409,
      body: { error: "config_unreadable", reason: "기존 model 키가 매핑이 아니다" },
    });
    assert.ok(got);
    assert.equal(got.code, "config_unreadable");
    assert.equal(got.message, "기존 model 키가 매핑이 아니다");
  });

  it("an object error without code folds to plugin_error but keeps message", () => {
    const got = mapPluginFailure({
      status: 500,
      body: { error: { message: "internal failure" } },
    });
    assert.ok(got);
    assert.equal(got.code, "plugin_error");
    assert.equal(got.message, "internal failure");
  });

  it("an array error does not take the object branch (code/message extraction)", () => {
    // typeof [] === "object", so without an Array.isArray guard, looking for nested.code could
    // silently hit undefined, or mistake an array element for a code.
    const got = mapPluginFailure({
      status: 400,
      body: { error: ["one", "two"], reason: "여러 문제가 있다" },
    });
    assert.ok(got);
    assert.equal(got.code, "plugin_error");
    assert.equal(got.message, "여러 문제가 있다", "reason 이 있으면 그것을 message 로 쓴다");
  });
});

describe("isCodeLikeString boundaries (fix round 3 I-4 — reviewer evidence)", () => {
  it("a one-word sentence starting with an uppercase letter is not mistaken for a code, and stays in message", () => {
    // The old regex (`i` flag) passed this as a code — then it became an unregistered code
    // (the UI shows "알 수 없는 오류"), and with no reason, message was "" too, so the original text vanished entirely.
    for (const sentence of ["Unauthorized", "Forbidden"]) {
      const got = mapPluginFailure({ status: 401, body: { error: sentence } });
      assert.ok(got);
      assert.equal(got.code, "upstream_error", `${sentence} 는 코드가 아니다`);
      assert.equal(got.message, sentence, `${sentence} 자체가 message 에 남아야 한다`);
    }
  });

  it("a lowercase single word without a separator (_ or -) is not mistaken for a code", () => {
    for (const word of ["conflict", "error", "failed"]) {
      const got = mapPluginFailure({ status: 409, body: { error: word } });
      assert.ok(got);
      assert.equal(got.code, "upstream_error", `${word} 는 구분자가 없어 코드가 아니다`);
      assert.equal(got.message, word);
    }
  });

  it("with an underscore like a registered code, it still passes as a code (regression guard)", () => {
    for (const code of [
      "config_unreadable",
      "already_exists",
      "profile_has_service",
      "gateway_auth_failed",
    ]) {
      const got = mapPluginFailure({ status: 409, body: { error: code } });
      assert.ok(got);
      assert.equal(got.code, code);
    }
  });

  it("when judged a code but with no reason, message is filled with the code string itself", () => {
    // I-4 (a): always fill message regardless of code judgment — leaving it an empty string
    // makes the UI's detail text vanish for no reason.
    const got = mapPluginFailure({ status: 409, body: { error: "revision_conflict" } });
    assert.ok(got);
    assert.equal(got.code, "revision_conflict");
    assert.equal(got.message, "revision_conflict");
  });

  it("with whitespace it is still treated as a sentence (regression guard for a path that was already safe)", () => {
    for (const sentence of ["Not Found", "Bad Request", "internal server error"]) {
      const got = mapPluginFailure({ status: 404, body: { error: sentence } });
      assert.ok(got);
      assert.equal(got.code, "upstream_error");
      assert.equal(got.message, sentence);
    }
  });
});

describe("automation contract failure codes", () => {
  it("400 unknown_cursor folds as the code itself — the poller must drop the cursor and restart", () => {
    const got = mapPluginFailure({ status: 400, body: { error: "unknown_cursor" } });
    assert.ok(got);
    assert.equal(got.code, "unknown_cursor");
    assert.equal(got.blocksEditor, false);
  });

  it("pluginUpgradeRequired carries the contract gate result into the same failure shape", () => {
    const got = pluginUpgradeRequired({
      ok: false,
      minVersion: "0.6.0",
      reason: "missing_capability",
      missing: ["events"],
    });
    assert.equal(got.code, "plugin_upgrade_required");
    assert.equal(got.blocksEditor, true);
    assert.equal(got.showsShellCommand, null);
    assert.deepEqual(got.details, {
      minVersion: "0.6.0",
      reason: "missing_capability",
      missing: ["events"],
    });
  });
});

// Swarm feature availability check (Task 5)
describe("swarm capability gate", () => {
  it("passes when capabilities include swarm", () => {
    const info = {
      version: "0.7.0",
      capabilities: ["kanban", "cron", "events", "swarm"],
    } as PluginInfo;
    assert.equal(supportsSwarm(info), true);
    assert.equal(swarmGate(info).ok, true);
  });

  it("rejects without the capability even if the version is higher", () => {
    // A Hermes build without the symbol. Looking only at the version gives "new plugin but 404".
    const info = { version: "0.9.0", capabilities: ["kanban", "cron", "events"] } as PluginInfo;
    assert.equal(supportsSwarm(info), false);
    const gate = swarmGate(info);
    assert.equal(gate.ok, false);
    assert.equal(gate.ok === false && gate.reason, "missing_capability");
    assert.deepEqual(gate.ok === false && gate.missing, ["swarm"]);
  });

  it("rejects when info is missing", () => {
    assert.equal(supportsSwarm(null), false);
    assert.equal(swarmGate(null).ok, false);
  });

  it("a swarm gate rejection is carried into the existing upgrade failure shape", () => {
    const gate = swarmGate({ version: "0.6.0", capabilities: ["kanban"] } as PluginInfo);
    assert.equal(gate.ok, false);
    const failure = pluginUpgradeRequired(gate as Exclude<typeof gate, { ok: true }>);
    assert.equal(failure.code, "plugin_upgrade_required");
    assert.equal(failure.details.minVersion, "0.7.0");
  });

  it("passes with the capability even if the version is lower", () => {
    // The gate does not look at the version. The plugin drops swarm from capabilities when the Hermes
    // build lacks it, so the capability alone is the source of truth for availability. The test fake server
    // actually reports 0.6.0 while carrying the swarm capability — this combination must pass.
    const info = {
      version: "0.6.0",
      capabilities: ["kanban", "cron", "events", "swarm"],
    } as PluginInfo;
    assert.equal(supportsSwarm(info), true);
    assert.equal(swarmGate(info).ok, true);
  });
});

describe("mapPluginFailure — native transition rejection reasons", () => {
  it("preserves the plugin detail sentence together with the code", () => {
    const detail = "human approval is required for this protected task";
    const got = mapPluginFailure({
      status: 409,
      body: { error: "invalid_transition", detail },
    });
    assert.ok(got);
    assert.equal(got.code, "invalid_transition");
    assert.equal(got.message, detail);
    assert.equal(got.details.detail, detail);
  });

  it("prefers the existing reason and does not stringify structured detail", () => {
    assert.equal(
      mapPluginFailure({
        status: 409,
        body: {
          error: "invalid_transition",
          reason: "기존 설명",
          detail: "추가 설명",
        },
      })?.message,
      "기존 설명",
    );
    assert.equal(
      mapPluginFailure({
        status: 409,
        body: {
          error: "invalid_transition",
          detail: { expected: "review" },
        },
      })?.message,
      "invalid_transition",
    );
  });
});
