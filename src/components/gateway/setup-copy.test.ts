import test from "node:test";
import assert from "node:assert/strict";
import {
  isSetupWarningBlocking,
  setupCopy,
  setupHostError,
  setupProgress,
  setupStep,
} from "./setup-copy";

test("host remediation is present in all four locales without raw error codes", () => {
  for (const code of [
    "managed_service_required",
    "windows_scheduled_task_missing",
    "service_identity_ambiguous",
    "service_identity_mismatch",
    "listener_owner_required",
    "external_secret_provider",
    "api_key_invalid",
    "multiplex_override_present",
    "multiplex_conflict",
    "port_conflict",
    "listener_ownership_unverified",
    "plugin_identity_ambiguous",
    "plugin_install_failed",
    "plugin_security_review_required",
    "plugin_source_unavailable",
    "gateway_restart_failed",
    "gateway_verification_failed",
    "profile_verification_failed",
    "host_operation_failed",
    "unsafe_host_path",
    "invalid_host_config",
    "invalid_candidate",
  ]) {
    for (const locale of ["ko", "en", "ja", "zh"] as const) {
      const message = setupHostError(locale, code);
      assert.ok(message && message.length > 20, `${locale}: ${code}`);
      assert.ok(!message.includes(code));
    }
  }
});
test("only known repairable warning states allow preparation", () => {
  for (const code of [
    undefined,
    "gateway_unreachable",
    "plugin_absent",
    "plugin_disabled",
    "plugin_pending_restart",
    "api_key_missing",
  ])
    assert.equal(isSetupWarningBlocking(code), false);
  for (const code of [
    "plugin_unauthorized",
    "multiplex_conflict",
    "external_secret_provider",
    "future_unknown_state",
  ])
    assert.equal(isSetupWarningBlocking(code), true);
  assert.equal(setupHostError("ko", "secret raw subprocess output"), undefined);
});

test("host_busy uses localized retry guidance", async () => {
  const { setupCopy, setupError } = await import("./setup-copy");
  for (const locale of ["ko", "en", "ja", "zh"] as const) {
    assert.equal(setupError(setupCopy[locale], "host_busy"), setupCopy[locale].busy);
  }
});

test("a new error code returns guidance text in all four languages without the raw code", async () => {
  const { setupCopy, setupError } = await import("./setup-copy");
  for (const code of [
    "hermes_version_unsupported",
    "plugin_update_failed",
    "service_install_failed",
    "timezone_invalid",
    "timezone_write_failed",
  ]) {
    for (const locale of ["ko", "en", "ja", "zh"] as const) {
      const message = setupHostError(locale, code);
      assert.ok(message && message.length > 20, `${locale}: ${code}`);
      assert.ok(!message.includes(code));
      // Must be more specific than the generic fallback, since host guidance exists.
      assert.notEqual(message, setupError(setupCopy[locale], code));
    }
  }
  assert.match(setupHostError("ko", "hermes_version_unsupported")!, /0\.21\.1/);
});

test("new progress steps have a unique label in all four languages", async () => {
  const { setupCopy, setupStep } = await import("./setup-copy");
  for (const locale of ["ko", "en", "ja", "zh"] as const) {
    const copy = setupCopy[locale];
    const labels = ["installing_service", "updating_plugin", "setting_timezone"].map((code) =>
      setupStep(copy, code),
    );
    for (const label of labels) {
      assert.ok(label.length > 0);
      assert.notEqual(label, copy.step, `${locale}: 일반 폴백으로 새면 안 된다`);
    }
    assert.equal(new Set(labels).size, 3, `${locale}: 세 단계가 서로 달라야 한다`);
    assert.ok(copy.pluginVersion.length > 0);
  }
});

test("contract 2's new error codes also return guidance in all four languages without the raw code", async () => {
  const { setupCopy, setupError } = await import("./setup-copy");
  for (const code of [
    "profile_name_invalid",
    "profile_exists",
    "profile_create_failed",
    "profile_key_failed",
    "profile_provision_forbidden",
    "profile_verify_failed",
    "hermes_already_installed",
    "hermes_install_forbidden",
    "hermes_install_failed",
    "hermes_installer_unavailable",
  ]) {
    for (const locale of ["ko", "en", "ja", "zh"] as const) {
      const message = setupHostError(locale, code);
      assert.ok(message && message.length > 20, `${locale}: ${code}`);
      assert.ok(!message.includes(code));
      assert.notEqual(message, setupError(setupCopy[locale], code));
    }
  }
});

test("warnings return guidance in all four languages, and an unknown code is not rendered", async () => {
  const { setupWarning } = await import("./setup-copy");
  for (const code of ["profile_not_served", "model_provider_required"]) {
    for (const locale of ["ko", "en", "ja", "zh"] as const) {
      const message = setupWarning(locale, code);
      assert.ok(message && message.length > 20, `${locale}: ${code}`);
      assert.ok(!message.includes(code));
    }
  }
  assert.match(setupWarning("ko", "model_provider_required")!, /hermes model/);
  // Anything off the whitelist is undefined — the raw code or host output must never leak.
  assert.equal(setupWarning("ko", "raw subprocess tail"), undefined);
  assert.equal(setupWarning("ko", undefined), undefined);
});

test("contract 2's new progress steps have a unique label in all four languages", async () => {
  const { setupCopy, setupStep } = await import("./setup-copy");
  for (const locale of ["ko", "en", "ja", "zh"] as const) {
    const copy = setupCopy[locale];
    const labels = ["installing_hermes", "creating_profile", "provisioning_keys"].map((code) =>
      setupStep(copy, code),
    );
    for (const label of labels) assert.notEqual(label, copy.step, `${locale}: 일반 폴백 금지`);
    assert.equal(new Set(labels).size, 3, `${locale}: 세 단계가 서로 달라야 한다`);
  }
});

test("install milestones exist in all four locales, and an unknown code returns nothing", () => {
  for (const code of ["deps", "clone", "venv", "node_modules", "skills", "done"]) {
    for (const locale of ["ko", "en", "ja", "zh"] as const) {
      const message = setupProgress(locale, code);
      assert.ok(message && message.length > 2, `${locale}: ${code}`);
    }
  }
  for (const code of [undefined, null, 42, "", "raw output line", "installing python 3.12"])
    assert.equal(setupProgress("ko", code), undefined);
});
test("the model-check step shows as text, not the raw code, in all four locales", () => {
  for (const locale of ["ko", "en", "ja", "zh"] as const) {
    const label = setupStep(setupCopy[locale], "checking_model");
    assert.ok(label && label.length > 2, locale);
    assert.ok(!label.includes("checking_model"));
    assert.notEqual(label, setupCopy[locale].step);
  }
});

test("update-only errors also state a reason in all four languages — never exposing the raw code on screen", async () => {
  for (const code of ["plugin_update_unsupported_host", "plugin_update_candidate_not_found"]) {
    for (const locale of ["ko", "en", "ja", "zh"] as const) {
      const message = setupHostError(locale, code);
      assert.ok(message && message.length > 20, `${locale}: ${code}`);
      assert.ok(!message.includes(code));
    }
  }
});

test("the Windows scheduled-task copy names the missing task and where to check, unlike the generic service copy", () => {
  for (const locale of ["ko", "en", "ja", "zh"] as const) {
    const windows = setupHostError(locale, "windows_scheduled_task_missing");
    assert.ok(windows && windows.includes("hermes gateway install"), locale);
    assert.notEqual(windows, setupHostError(locale, "managed_service_required"), locale);
  }
  assert.match(setupHostError("ko", "windows_scheduled_task_missing")!, /작업 스케줄러/);
  assert.match(setupHostError("en", "windows_scheduled_task_missing")!, /Task Scheduler/);
});
