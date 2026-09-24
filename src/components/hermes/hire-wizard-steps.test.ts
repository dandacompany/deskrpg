import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  availableSteps,
  classifyServingCheck,
  identityDecision,
  nextStep,
} from "./hire-wizard-steps";

describe("availableSteps — the shrinking ladder", () => {
  it("all 4 steps open when there's a plugin and a profile — 1 profile 2 identity 3 appearance 4 AI model", () => {
    const steps = availableSteps("plugin_ready", false, true);
    assert.deepEqual(
      steps.map((s) => s.step),
      ["profile", "identity", "appearance", "config"],
    );
    assert.ok(steps.every((s) => s.enabled));
  });

  it("before a profile is created, identity/AI model are locked with a reason", () => {
    // Observed in production 2026-09-18: with step 2 unlocked, an empty lookup result showed
    // "can't read the identity file," and step 3 fell back to free-text input because it
    // couldn't fetch the model list.
    const steps = availableSteps("plugin_ready", false, false);
    const byStep = Object.fromEntries(steps.map((s) => [s.step, s]));
    assert.equal(byStep.profile.enabled, true);
    assert.equal(byStep.identity.enabled, false);
    assert.equal(byStep.config.enabled, false);
    assert.equal(byStep.identity.lockedReason, "hermes.wizard.locked.needsProfile");
    assert.equal(byStep.config.lockedReason, "hermes.wizard.locked.needsProfile");
    assert.equal(byStep.appearance.enabled, false);
    assert.equal(byStep.appearance.lockedReason, "hermes.wizard.locked.needsProfile");
  });

  it("appearance is independent of the plugin — it opens with only a profile, even without a plugin", () => {
    const steps = availableSteps("plugin_absent", true, true);
    assert.equal(steps.find((s) => s.step === "appearance")!.enabled, true);
  });

  it("with no plugin but local discovery available, only identity/AI model are locked", () => {
    // A profile can be found and registered via filesystem discovery.
    // Only identity/config have no way to be reached remotely.
    const steps = availableSteps("plugin_absent", true, true);
    const byStep = Object.fromEntries(steps.map((s) => [s.step, s]));
    assert.equal(byStep.profile.enabled, true);
    assert.equal(byStep.identity.enabled, false);
    assert.equal(byStep.config.enabled, false);
    assert.equal(byStep.identity.lockedReason, "hermes.plugin.locked.absent");
  });

  it("the plugin-locked reason takes priority over no-profile — creating a profile still won't unlock it", () => {
    const steps = availableSteps("plugin_absent", false, false);
    assert.equal(
      steps.find((s) => s.step === "identity")!.lockedReason,
      "hermes.plugin.locked.absent",
    );
  });

  it("401 gives a different reason than 404", () => {
    // What the user needs to do is the opposite in each case — replace the key vs. install the plugin.
    const unauthorized = availableSteps("plugin_unauthorized", false, false);
    const absent = availableSteps("plugin_absent", false, false);
    const a = unauthorized.find((s) => s.step === "profile")!.lockedReason;
    const b = absent.find((s) => s.step === "profile")!.lockedReason;
    assert.ok(a);
    assert.ok(b);
    assert.notEqual(a, b);
  });

  it("unknown does not enable the feature", () => {
    const steps = availableSteps("unknown", false, true);
    assert.equal(steps.find((s) => s.step === "identity")!.enabled, false);
  });
});

describe("identityDecision — never unknowingly erases a human-written identity", () => {
  it("edits immediately if it's the default template", () => {
    assert.equal(identityDecision({ isDefaultTemplate: true }), "edit_fresh");
  });

  it("asks first if it's human-written", () => {
    assert.equal(identityDecision({ isDefaultTemplate: false }), "ask_overwrite");
  });

  it("does not open the editor if unreadable", () => {
    // Opening an empty editor would erase the original with a single save.
    assert.equal(identityDecision({ isDefaultTemplate: null, unreadable: true }), "blocked");
  });

  it("treats isDefaultTemplate: null as unreadable", () => {
    // Treating null like false wrongly infers "human-written" and offers to overwrite;
    // treating it like true opens an empty editor right away. Both are dangerous.
    assert.equal(identityDecision({ isDefaultTemplate: null }), "blocked");
  });
});

describe("nextStep", () => {
  it("skips locked steps", () => {
    const steps = availableSteps("plugin_absent", true, true);
    assert.equal(nextStep("profile", steps), "appearance");
    assert.equal(nextStep("appearance", steps), null);
  });

  it("after step 2 comes step 3 appearance, after step 3 comes step 4 AI model", () => {
    const steps = availableSteps("plugin_ready", false, true);
    assert.equal(nextStep("identity", steps), "appearance");
    assert.equal(nextStep("appearance", steps), "config");
  });

  it("after step 1 comes step 2", () => {
    const steps = availableSteps("plugin_ready", false, true);
    assert.equal(nextStep("profile", steps), "identity");
  });

  it("step 4 AI model is the last step", () => {
    const steps = availableSteps("plugin_ready", false, true);
    assert.equal(nextStep("config", steps), null);
  });
});

describe("classifyServingCheck — distinguishes 401 from 404 (fix round 1)", () => {
  it("no errorCode means it's served", () => {
    assert.equal(classifyServingCheck({ errorCode: null, upstreamStatus: null }), "served");
  });

  it("an upstream 401 is a key problem — needs different guidance than the allowlist message", () => {
    assert.equal(
      classifyServingCheck({ errorCode: "plugin_error", upstreamStatus: 401 }),
      "key_rejected",
    );
  });

  it("an upstream 404 means this gateway doesn't serve the new profile", () => {
    assert.equal(
      classifyServingCheck({ errorCode: "plugin_error", upstreamStatus: 404 }),
      "not_served",
    );
  });

  it("if the upstream status isn't 401/404, even a named errorCode collapses to unknown", () => {
    // A problem unrelated to serving, like identity_unreadable(409), must not be
    // mistaken for 401/404 and given the wrong guidance — this case falls through to
    // the generic errorCode message.
    assert.equal(
      classifyServingCheck({ errorCode: "identity_unreadable", upstreamStatus: 409 }),
      "unknown",
    );
  });

  it("an unreachable status (0) or any other status code collapses to unknown", () => {
    assert.equal(classifyServingCheck({ errorCode: "unreachable", upstreamStatus: 0 }), "unknown");
    assert.equal(classifyServingCheck({ errorCode: "timeout", upstreamStatus: null }), "unknown");
  });
});

describe("identityDecision — blocks anything that isn't a boolean", () => {
  // Actually happened in staging (2026-09-02): the plugin honestly returned
  // `isDefaultTemplate: true`, but the screen asked "an identity already exists."
  // Response parsing broke, `{}` flowed in as the payload, and `undefined` being falsy
  // collapsed it to ask_overwrite. Filtering only `=== null` isn't enough — the
  // fallback happened to land on the dangerous side.
  const cases: Array<[string, unknown, string]> = [
    ["필드가 아예 없다", {}, "blocked"],
    ["undefined 를 명시", { isDefaultTemplate: undefined }, "blocked"],
    ["null", { isDefaultTemplate: null }, "blocked"],
    ["문자열 'true'", { isDefaultTemplate: "true" }, "blocked"],
    ["숫자 1", { isDefaultTemplate: 1 }, "blocked"],
    ["진짜 true", { isDefaultTemplate: true }, "edit_fresh"],
    ["진짜 false", { isDefaultTemplate: false }, "ask_overwrite"],
  ];

  for (const [name, payload, expected] of cases) {
    it(name, () => {
      assert.equal(identityDecision(payload as Parameters<typeof identityDecision>[0]), expected);
    });
  }

  it("unreadable is blocked before anything else", () => {
    assert.equal(identityDecision({ isDefaultTemplate: true, unreadable: true }), "blocked");
  });
});
