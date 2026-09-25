import assert from "node:assert/strict";
import test from "node:test";

import { SSH_OPTIONS } from "./executor";
import { forwardArgs, tunnelArgs, usesControlMaster } from "./ssh-args";

const base = {
  routeArgs: ["-F", "/home/u/.deskrpg/ssh/config"],
  routeOptions: [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "A=1",
    "-o",
    "B=2",
  ],
  dest: "h-1",
  socket: "/tmp/deskrpg-ssh-x/master",
  localPort: 41000,
  remotePort: 8642,
};

test("win32 does not use multiplexing", () => {
  assert.equal(usesControlMaster("win32"), false);
  assert.equal(usesControlMaster("darwin"), true);
  assert.equal(usesControlMaster("linux"), true);
});

test("win32 tunnels do not enable multiplexing", () => {
  // Checked with the real SSH_OPTIONS. That array contains `ControlMaster=no`·`ControlPath=none`,
  // and the POSIX branch's slice(0, -4) is exactly the device that strips those two to enable the master
  // (`SSH_OPTIONS` in executor.ts).
  // So win32 using the full options is what "mux is explicitly off" means.
  const args = tunnelArgs({ ...base, routeOptions: [...SSH_OPTIONS], platform: "win32" });
  const joined = args.join(" ");
  assert.ok(joined.includes("ControlMaster=no"), "mux 는 명시적으로 꺼져야 한다");
  assert.ok(!joined.includes("ControlMaster=auto"));
  assert.ok(!args.includes("-S") && !args.includes("-M"));
  assert.ok(!joined.includes("/dev/null"));
  assert.ok(joined.includes("-L 127.0.0.1:41000:127.0.0.1:8642"));
  assert.ok(joined.includes("ExitOnForwardFailure=yes"));
  assert.ok(args.includes("-N") && args.includes("-T"));
  assert.equal(args[args.length - 1], "h-1");
  assert.equal(args[args.length - 2], "--");
});

test("win32 tunnels bind the local side only to 127.0.0.1", () => {
  const args = tunnelArgs({ ...base, platform: "win32" });
  assert.ok(!args.join(" ").includes("0.0.0.0"));
});

test("POSIX tunnel args are unchanged from current behavior", () => {
  const args = tunnelArgs({ ...base, platform: "linux" });
  assert.deepEqual(args, [
    "-F",
    "/home/u/.deskrpg/ssh/config",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-M",
    "-S",
    "/tmp/deskrpg-ssh-x/master",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-N",
    "-T",
    "--",
    "h-1",
  ]);
});

test("POSIX forward args use the control socket", () => {
  const args = forwardArgs({
    platform: "linux",
    socket: "/tmp/s/master",
    hostId: "h-1",
    localPort: 41000,
    remotePort: 8642,
  });
  assert.deepEqual(args, [
    "-F",
    "/dev/null",
    "-S",
    "/tmp/s/master",
    "-O",
    "forward",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-L",
    "127.0.0.1:41000:127.0.0.1:8642",
    "--",
    "h-1",
  ]);
});

test("rejects a request for forward args on win32", () => {
  assert.throws(
    () =>
      forwardArgs({
        platform: "win32",
        socket: "x",
        hostId: "h-1",
        localPort: 1,
        remotePort: 2,
      }),
    /setup_invalid_request/,
  );
});
