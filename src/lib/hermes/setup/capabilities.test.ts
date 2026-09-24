import assert from "node:assert/strict";
import test from "node:test";

import { describeCapabilities, type CapabilityProbe } from "./capabilities";

const base: CapabilityProbe = {
  role: "system_admin",
  switchedOff: false,
  installAllowed: true,
  platform: "linux",
  hasSsh: true,
  hasPowershell: false,
  inContainer: false,
  localHermesFound: true,
  hostLabel: "minipc",
  sshHosts: [{ id: "h-1", label: "h-1" }],
};

test("admins get local and SSH open without an env var", () => {
  const c = describeCapabilities(base);
  assert.equal(c.local, true);
  assert.equal(c.ssh, true);
  assert.equal(c.localReason, null);
  assert.equal(c.sshReason, null);
});

test("non-admins or operator-disabled close both, with different reasons", () => {
  const user = describeCapabilities({ ...base, role: "user" });
  assert.equal(user.local, false);
  assert.equal(user.localReason, "not_admin");
  assert.equal(user.sshReason, "not_admin");
  assert.deepEqual(user.sshHosts, []);
  assert.equal(user.hostLabel, "");
  const off = describeCapabilities({ ...base, switchedOff: true });
  assert.equal(off.localReason, "disabled");
  assert.equal(off.sshReason, "disabled");
});

test("without Hermes locally, it stays open and offers to install", () => {
  const c = describeCapabilities({ ...base, localHermesFound: false });
  assert.equal(c.local, true);
  assert.equal(c.canInstallHermes, true);
  assert.equal(
    describeCapabilities({ ...base, localHermesFound: false, installAllowed: false })
      .canInstallHermes,
    false,
  );
  assert.equal(describeCapabilities(base).canInstallHermes, false, "이미 있으면 설치하지 않는다");
});

test("closes local when Hermes isn't in the container — not because it's Docker but because the install wouldn't persist", () => {
  const c = describeCapabilities({ ...base, inContainer: true, localHermesFound: false });
  assert.equal(c.local, false);
  assert.equal(c.localReason, "container_without_hermes");
  assert.equal(c.canInstallHermes, false);
  // If Hermes is baked into the image, use it even in a container.
  assert.equal(describeCapabilities({ ...base, inContainer: true }).local, true);
});

test("without ssh it gives that reason — python3 is not a reason (the install fetches python too)", () => {
  const noSsh = describeCapabilities({ ...base, hasSsh: false });
  assert.equal(noSsh.ssh, false);
  assert.equal(noSsh.sshReason, "ssh_missing");
  assert.equal(
    describeCapabilities({ ...base, platform: "win32" }).localReason,
    "unsupported_platform",
  );
});

test("SSH opens even with no registered hosts — they're registered on screen", () => {
  const c = describeCapabilities({ ...base, sshHosts: [] });
  assert.equal(c.ssh, true);
  assert.equal(c.canInstallHermesSsh, true);
});

test("win32 opens local when powershell exists", () => {
  const c = describeCapabilities({
    ...base,
    platform: "win32",
    hasPowershell: true,
    localHermesFound: false,
  });
  assert.equal(c.local, true);
  assert.equal(c.localReason, null);
  assert.equal(c.canInstallHermes, true);
});

test("win32 blocks local without powershell", () => {
  const c = describeCapabilities({ ...base, platform: "win32", hasPowershell: false });
  assert.equal(c.local, false);
  assert.equal(c.localReason, "unsupported_platform");
});

test("non-win32 doesn't look at hasPowershell", () => {
  const c = describeCapabilities({ ...base, platform: "linux", hasPowershell: false });
  assert.equal(c.local, true);
});
