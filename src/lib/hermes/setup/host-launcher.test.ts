import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HOST_LAUNCHER } from "./host-helper";

/** Runs the launcher on a real /bin/sh with an isolated HOME/PATH. The system python3 is not on PATH. */
function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deskrpg-launcher-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  for (const tool of ["sh", "mkdir", "rm", "mktemp", "cat", "chmod", "id", "uname", "tr", "cut"]) {
    const found = ["/bin", "/usr/bin"].map((d) => path.join(d, tool)).find((p) => existsSync(p));
    if (found) symlinkSync(found, path.join(bin, tool));
  }
  const script = (file: string, body: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  const run = (mode: string, code = "CODE", none = '{"candidates": []}') =>
    spawnSync("/bin/sh", ["-c", HOST_LAUNCHER, "deskrpg", mode, code, none], {
      env: { HOME: home, PATH: bin } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 10000,
    }).stdout;
  /** A server with curl, git and a C++ compiler — passes the pre-install check. */
  const tools = () => {
    script(path.join(bin, "git"), "echo git version 2.0");
    script(path.join(bin, "g++"), "exit 0");
    if (!existsSync(path.join(bin, "curl"))) script(path.join(bin, "curl"), "exit 1");
  };
  return {
    root,
    home,
    bin,
    script,
    run,
    tools,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("runs with the Hermes venv python when present", () => {
  const s = sandbox();
  try {
    s.script(path.join(s.home, ".hermes/hermes-agent/venv/bin/python"), 'echo "venv:$2"');
    s.script(path.join(s.bin, "python3"), 'echo "system:$2"');
    assert.equal(s.run("run").trim(), "venv:CODE");
  } finally {
    s.done();
  }
});

test("uses the system python3 when there is no venv", () => {
  const s = sandbox();
  try {
    s.tools();
    s.script(path.join(s.bin, "python3"), 'echo "system:$2"');
    assert.equal(s.run("install").trim(), "system:CODE");
  } finally {
    s.done();
  }
});

test("with no python at all, discovery returns the given JSON as-is (-> install offer)", () => {
  const s = sandbox();
  try {
    assert.equal(s.run("run"), '{"candidates": []}');
  } finally {
    s.done();
  }
});

test("when packages that can't be installed without sudo are missing, returns the list and distro before install", () => {
  const s = sandbox();
  try {
    s.script(path.join(s.bin, "sudo"), "exit 1");
    const body = JSON.parse(s.run("install"));
    assert.equal(body.error, "system_packages_missing");
    assert.deepEqual(body.packages.trim().split(" "), ["curl", "git", "cxx"]);
    s.tools();
    s.script(path.join(s.bin, "curl"), "exit 0");
    s.script(path.join(s.bin, "python3"), 'echo "system:$2"');
    assert.equal(s.run("install").trim(), "system:CODE");
  } finally {
    s.done();
  }
});

test("install without python3 downloads uv into ~/.hermes/bin and runs the driver with uv python", () => {
  const s = sandbox();
  try {
    s.tools();
    const py = path.join(s.root, "uvpython", "python3.12");
    s.script(py, 'echo "uv-python:$2"');
    // Fake curl: writes a "uv install script" to the -o target. That script creates uv in UV_UNMANAGED_INSTALL.
    s.script(
      path.join(s.bin, "curl"),
      `out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out=$2; shift; done
cat > "$out" <<'UV'
mkdir -p "$UV_UNMANAGED_INSTALL"
cat > "$UV_UNMANAGED_INSTALL/uv" <<'BIN'
#!/bin/sh
[ "$2" = find ] && echo "${py}"
exit 0
BIN
chmod +x "$UV_UNMANAGED_INSTALL/uv"
UV`,
    );
    assert.equal(s.run("install").trim(), "uv-python:CODE");
    assert.ok(existsSync(path.join(s.home, ".hermes/bin/uv")));
  } finally {
    s.done();
  }
});

test("downloads nothing when ~/.hermes is a symlink", () => {
  const s = sandbox();
  try {
    mkdirSync(path.join(s.root, "elsewhere"));
    symlinkSync(path.join(s.root, "elsewhere"), path.join(s.home, ".hermes"));
    s.tools();
    s.script(path.join(s.bin, "curl"), "echo should-not-run >&2; exit 1");
    assert.deepEqual(JSON.parse(s.run("install")), { error: "unsafe_host_path" });
  } finally {
    s.done();
  }
});

test("package commands — built per distro, null for an unknown distro", async () => {
  const { packageManagerFor, parseSystemPackages, systemPackagesCommand } =
    await import("./system-packages");
  const pkgs = parseSystemPackages(" git cxx evil;rm ");
  assert.deepEqual(pkgs, ["git", "cxx"]);
  assert.equal(
    systemPackagesCommand(packageManagerFor("ubuntu"), pkgs),
    "sudo apt-get update && sudo apt-get install -y git build-essential",
  );
  assert.equal(
    systemPackagesCommand(packageManagerFor("fedora"), pkgs),
    "sudo dnf install -y git gcc-c++",
  );
  assert.equal(systemPackagesCommand(packageManagerFor("macos"), pkgs), "xcode-select --install");
  assert.equal(systemPackagesCommand(packageManagerFor("plan9"), pkgs), null);
});
