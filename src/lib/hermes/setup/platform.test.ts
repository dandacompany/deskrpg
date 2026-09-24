import assert from "node:assert/strict";
import test from "node:test";

import path from "node:path";

import {
  DEFAULT_PATHEXT,
  hasCommandIn,
  hermesRootPath,
  isWindows,
  nullDevicePath,
  venvPythonPath,
} from "./platform";

const winEnv = {
  PATH: "C:\\WINDOWS\\system32;C:\\WINDOWS\\System32\\OpenSSH\\",
  PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS",
};
const present = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

test("win32 appends PATHEXT extensions to find ssh.exe", () => {
  const access = present("C:\\WINDOWS\\System32\\OpenSSH\\ssh.exe");
  assert.equal(hasCommandIn("ssh", winEnv, "win32", access), true);
});

test("win32 still tries the extensionless name", () => {
  const access = present("C:\\WINDOWS\\system32\\ssh");
  assert.equal(hasCommandIn("ssh", winEnv, "win32", access), true);
});

test("win32 uses the default when PATHEXT is empty", () => {
  const access = present("C:\\WINDOWS\\system32\\powershell.EXE");
  assert.equal(
    hasCommandIn("powershell", { PATH: "C:\\WINDOWS\\system32" }, "win32", access),
    true,
  );
  assert.ok(DEFAULT_PATHEXT.includes(".EXE"));
});

test("win32 returns false for a missing command", () => {
  assert.equal(
    hasCommandIn("ssh", winEnv, "win32", () => false),
    false,
  );
});

test("non-win32 doesn't append extensions", () => {
  const access = present("/usr/bin/ssh.exe");
  assert.equal(hasCommandIn("ssh", { PATH: "/usr/bin" }, "linux", access), false);
  assert.equal(hasCommandIn("ssh", { PATH: "/usr/bin" }, "linux", present("/usr/bin/ssh")), true);
});

test("returns false when PATH is empty", () => {
  assert.equal(
    hasCommandIn("ssh", {}, "linux", () => true),
    false,
  );
});

test("the null device name differs by platform", () => {
  assert.equal(nullDevicePath("win32"), "NUL");
  assert.equal(nullDevicePath("darwin"), "/dev/null");
  assert.equal(isWindows("win32"), true);
  assert.equal(isWindows("linux"), false);
});

test("Hermes home is under LOCALAPPDATA on Windows", () => {
  assert.equal(
    hermesRootPath("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u"),
    path.join("C:\\Users\\u\\AppData\\Local", "hermes"),
  );
  assert.equal(
    hermesRootPath("win32", {}, "C:\\Users\\u"),
    path.join("C:\\Users\\u", "AppData", "Local", "hermes"),
  );
  assert.equal(hermesRootPath("linux", {}, "/home/u"), path.join("/home/u", ".hermes"));
});

test("the venv python location follows the platform", () => {
  assert.equal(venvPythonPath("win32", "/v"), path.join("/v", "Scripts", "python.exe"));
  assert.equal(venvPythonPath("darwin", "/v"), path.join("/v", "bin", "python"));
});
