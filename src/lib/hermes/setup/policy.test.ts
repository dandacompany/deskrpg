import test from "node:test";
import assert from "node:assert/strict";
import {
  hermesInstallAllowed,
  hostSetupAllowed,
  validateProfileName,
  validateProfileDescription,
  sameOriginMutation,
  validateGatewayUrl,
  safeSetupError,
  validateTimezone,
  validateSetupPort,
  collectSetupWarnings,
  SETUP_WARNING_CODES,
} from "./policy";

test("host execution is open by default for system_admin, and the operator can turn it off with 0", () => {
  // 2026-09-19 Dante decision: admins use local/SSH without env vars. The switch remains only for refusing.
  assert.equal(hostSetupAllowed({}, "system_admin"), true);
  assert.equal(hostSetupAllowed({}, "user"), false);
  assert.equal(hostSetupAllowed({}, undefined), false);
  for (const off of ["0", "false", "no", "off", " OFF "]) {
    assert.equal(hostSetupAllowed({ DESKRPG_HOST_SETUP_ENABLED: off }, "system_admin"), false, off);
  }
  assert.equal(hostSetupAllowed({ DESKRPG_HOST_SETUP_ENABLED: "1" }, "system_admin"), true);
  assert.equal(hostSetupAllowed({ DESKRPG_HOST_SETUP_ENABLED: "1" }, "user"), false);
});
test("mutations fail closed for absent, cross-site or malformed origin", () => {
  assert.equal(sameOriginMutation("http://localhost:3102", "localhost:3102"), true);
  assert.equal(sameOriginMutation("https://evil.test", "localhost:3102"), false);
  assert.equal(sameOriginMutation(null, "localhost:3102"), false);
  assert.equal(sameOriginMutation("null", "localhost:3102"), false);
  assert.equal(sameOriginMutation("http://localhost:3102", "localhost:3102", "cross-site"), false);
});
test("gateway target supports private networks but excludes credential URLs and metadata", () => {
  assert.equal(validateGatewayUrl("http://127.0.0.1:8642/"), "http://127.0.0.1:8642");
  assert.equal(
    validateGatewayUrl("https://gateway.example/prefix"),
    "https://gateway.example/prefix",
  );
  for (const url of [
    "file:///etc/passwd",
    "http://user:pass@host",
    "http://169.254.169.254",
    "http://metadata.google.internal",
    "http://metadata.google.internal./",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[fe90::1]/",
    "http://[febf::1]/",
    "http://host/?token=secret",
    "http://host/#secret",
    "http://evil.deskrpg-ssh.invalid",
  ]) {
    assert.throws(() => validateGatewayUrl(url));
  }
});
test("unexpected subprocess/DB messages never leave server", () => {
  assert.equal(safeSetupError(new Error("ssh failed token=secret-value")), "setup_failed");
  assert.equal(safeSetupError(new Error("multiplex_conflict")), "multiplex_conflict");
});

test("security scan and source failures are safe structured errors", () => {
  for (const code of ["plugin_security_review_required", "plugin_source_unavailable"])
    assert.equal(safeSetupError(new Error(code)), code);
});

test("rejects time zones containing dot segments even if the shape matches", () => {
  // `Asia/../Seoul` passes the regex but zoneinfo can't resolve it —
  // don't leave a value in the operator's config.yaml that can't be used.
  for (const bad of ["Asia/../Seoul", "Asia/./Seoul", "../Seoul"]) {
    assert.throws(() => validateTimezone(bad), /timezone_invalid/);
  }
  assert.equal(validateTimezone("Asia/Seoul"), "Asia/Seoul");
});

test("Hermes install is open by default to admins for both local and SSH, and closed if either switch is 0", () => {
  assert.equal(hermesInstallAllowed({}, "system_admin", "local"), true);
  assert.equal(hermesInstallAllowed({}, "system_admin", "ssh"), true);
  assert.equal(hermesInstallAllowed({}, "user", "local"), false);
  assert.equal(
    hermesInstallAllowed({ DESKRPG_HERMES_INSTALL_ENABLED: "0" }, "system_admin", "local"),
    false,
  );
  assert.equal(
    hermesInstallAllowed({ DESKRPG_HOST_SETUP_ENABLED: "0" }, "system_admin", "ssh"),
    false,
  );
  // Don't open when there's no target or the mode is unknown.
  assert.equal(hermesInstallAllowed({}, "system_admin", undefined), false);
  assert.equal(hermesInstallAllowed({}, "system_admin", "url"), false);
});
test("profile names are up to 64 lowercase letters, digits, and hyphens, and reserved words are rejected", () => {
  assert.equal(validateProfileName("sophie-2"), "sophie-2");
  assert.equal(validateProfileName(" sophie "), "sophie");
  for (const bad of [
    "Sophie",
    "-sophie",
    "so phie",
    "a".repeat(65),
    "",
    "default",
    "hermes",
    "root",
    "sudo",
    "tmp",
    "test",
    42,
  ])
    assert.throws(() => validateProfileName(bad), /profile_name_invalid/);
});
test("profile descriptions accept only a single line of up to 200 chars", () => {
  assert.equal(validateProfileDescription("리서치 담당"), "리서치 담당");
  assert.equal(validateProfileDescription(undefined), undefined);
  assert.equal(validateProfileDescription("   "), undefined);
  for (const bad of ["x".repeat(201), "두\n줄", "캐리지\r리턴", 7])
    assert.throws(() => validateProfileDescription(bad), /profile_name_invalid/);
});
test("new error codes from contract 2 pass through as-is and everything else is setup_failed", () => {
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
  ])
    assert.equal(safeSetupError(new Error(code)), code);
  // Warnings don't go on the error path.
  for (const warning of ["profile_not_served", "model_provider_required"])
    assert.equal(safeSetupError(new Error(warning)), "setup_failed");
});

test("adds a model provider warning when Hermes was just installed", () => {
  // Even with no providers, /v1/models returns 200 and one model (measured) —
  // an empty list can't be used to decide, so the fact that "we installed it" is the signal.
  assert.deepEqual(collectSetupWarnings([], true), ["model_provider_required"]);
  assert.deepEqual(collectSetupWarnings(undefined, false), []);
});

test("preserves warnings given by the host and folds duplicates", () => {
  assert.deepEqual(collectSetupWarnings(["profile_not_served"], true), [
    "profile_not_served",
    "model_provider_required",
  ]);
  assert.deepEqual(collectSetupWarnings(["model_provider_required"], true), [
    "model_provider_required",
  ]);
});

test("when the model check is ready, the warning disappears even right after install", () => {
  // If a check is possible, the check wins — "installed, so warn" is only a guess.
  assert.deepEqual(collectSetupWarnings([], true, "ready"), []);
  assert.deepEqual(collectSetupWarnings(["model_provider_required"], false, "ready"), []);
  assert.deepEqual(collectSetupWarnings(["profile_not_served"], true, "ready"), [
    "profile_not_served",
  ]);
});
test("when the model check is missing, adds the warning even without installing", () => {
  assert.deepEqual(collectSetupWarnings([], false, "missing"), ["model_provider_required"]);
  assert.deepEqual(collectSetupWarnings([], true, "missing"), ["model_provider_required"]);
});
test("when the verdict is unknown or absent, the existing rule applies unchanged", () => {
  assert.deepEqual(collectSetupWarnings([], true, "unknown"), ["model_provider_required"]);
  assert.deepEqual(collectSetupWarnings([], false, "unknown"), []);
  assert.deepEqual(collectSetupWarnings([], false, undefined), []);
});
test("new error codes from contract 3 also pass the whitelist", () => {
  assert.equal(safeSetupError(new Error("resume_unavailable")), "resume_unavailable");
});

test("an accepted port passes only as an integer in 1024–65535", () => {
  assert.equal(validateSetupPort(8643), 8643);
  assert.equal(validateSetupPort(1024), 1024);
  assert.equal(validateSetupPort(65535), 65535);
  for (const value of [1023, 65536, 8643.5, "8643", null, undefined, NaN, Infinity])
    assert.throws(() => validateSetupPort(value), /setup_invalid_request/);
});
test("port write failures go out as-is with a whitelisted code", () => {
  assert.equal(safeSetupError(new Error("port_write_failed")), "port_write_failed");
  assert.equal(safeSetupError(new Error("port_write_failed /home/op/.env")), "setup_failed");
});
test("logon_required is a warning, not a failure", () => {
  assert.ok(SETUP_WARNING_CODES.has("logon_required"));
  assert.equal(safeSetupError(new Error("logon_required")), "setup_failed");
});
