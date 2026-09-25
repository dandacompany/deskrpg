import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HOST_HELPER } from "./host-helper";

// On Windows the wizard used to restart the gateway with `schtasks /End` + `/Run`, which ends the task at
// once and can cut off a running card or cron job. Upstream Hermes' own Windows restart
// (hermes_cli/gateway_windows.py `restart`) writes the planned-stop marker, lets the gateway drain, then
// ends the task, waits for it to be gone and starts it again. The helper now calls that CLI when the
// installed Hermes has it, and keeps the old commands for a Hermes that cannot drain.

/** Runs HOST_HELPER with yaml/agent stubbed and a fake `hermes_cli.gateway_windows` module on disk. */
function helper(script: string, gatewayWindowsSource: string | null) {
  const temp = mkdtempSync(join(tmpdir(), "deskrpg-win-restart-test-"));
  try {
    mkdirSync(join(temp, ".hermes/hermes-agent"), { recursive: true });
    const lib = join(temp, "lib");
    mkdirSync(join(lib, "hermes_cli"), { recursive: true });
    writeFileSync(join(lib, "hermes_cli/__init__.py"), "");
    if (gatewayWindowsSource !== null)
      writeFileSync(join(lib, "hermes_cli/gateway_windows.py"), gatewayWindowsSource);
    const stubs = String.raw`
import types, sys, json
sys.modules['yaml'] = types.SimpleNamespace(safe_load=lambda text: json.loads(text) if text else {}, safe_dump=lambda value, **kwargs: json.dumps(value))
sys.modules['agent'] = types.ModuleType('agent')
sys.modules['agent.secret_scope'] = types.SimpleNamespace(load_env_file=lambda path: {})
`;
    const result = spawnSync("python3", ["-"], {
      input: stubs + HOST_HELPER + "\n" + script,
      encoding: "utf8",
      env: { ...process.env, HOME: temp, PYTHONPATH: lib, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const DRAINING = `
def _drain_gateway_pid(pid, drain_timeout):
    from gateway.status import write_planned_stop_marker
def restart():
    pass
`;
const PRE_DRAIN = `
def restart():
    pass
`;

const plan = String.raw`
command, env, stop = windows_restart('Hermes_Gateway', 'default', pathlib.Path('C:/Users/u/AppData/Local/hermes'), 'C:/h/venv/Scripts/python.exe')
print(json.dumps({'command': command, 'env': None if env is None else {k: env[k] for k in ('HERMES_HOME', 'PYTHONUTF8', 'PYTHONIOENCODING')}, 'stop': stop}))
`;

test("a Hermes that drains is restarted through its own CLI, pinned to the gateway's home", () => {
  const got = helper(plan, DRAINING);
  assert.deepEqual(got.command, [
    "C:/h/venv/Scripts/python.exe",
    "-m",
    "hermes_cli.main",
    "gateway",
    "restart",
  ]);
  assert.equal(got.env.HERMES_HOME, "C:/Users/u/AppData/Local/hermes");
  // The CLI prints non-ASCII status marks; a cp949 pipe must not crash it mid-restart.
  assert.equal(got.env.PYTHONUTF8, "1");
  assert.equal(got.env.PYTHONIOENCODING, "utf-8");
  // Upstream drains up to 30s and waits up to 40s more for the old process before starting.
  assert.ok(got.stop >= 70, `stop budget ${got.stop}`);
});

test("a named profile's gateway is restarted with its profile", () => {
  const got = helper(
    String.raw`
command, env, stop = windows_restart('Hermes_Gateway_mia', 'mia', pathlib.Path('C:/h/profiles/mia'), 'C:/h/venv/Scripts/python.exe')
print(json.dumps(command))
`,
    DRAINING,
  );
  assert.deepEqual(got, [
    "C:/h/venv/Scripts/python.exe",
    "-m",
    "hermes_cli.main",
    "--profile",
    "mia",
    "gateway",
    "restart",
  ]);
});

test("a Hermes without the drain keeps the scheduled-task restart", () => {
  for (const source of [PRE_DRAIN, null]) {
    const got = helper(plan, source);
    assert.deepEqual(got, {
      command: ["cmd", "/c", "schtasks /End /TN Hermes_Gateway & schtasks /Run /TN Hermes_Gateway"],
      env: null,
      stop: null,
    });
  }
});

test("the restart action runs the planned command with its environment and budget", () => {
  const got = helper(
    String.raw`
seen = {}
def fake_run(argv, timeout=8, env=None):
    seen.update(argv=argv, timeout=timeout, home=None if env is None else env.get('HERMES_HOME'))
    return types.SimpleNamespace(returncode=0, stdout='')
run = fake_run
preflight = lambda *args, **kwargs: None
owner = {'command': ['py', '-m', 'hermes_cli.main', 'gateway', 'restart'], 'env': {'HERMES_HOME': 'H'}, 'stop': 120}
identity = lambda name, home: owner
select = lambda candidate_id: ('default', ROOT, ({'id': 'x'}, owner, {}, 'tok', 'deskrpg'))
main('restart', 'x')
print(json.dumps(seen))
`,
    DRAINING,
  );
  assert.deepEqual(got.argv, ["py", "-m", "hermes_cli.main", "gateway", "restart"]);
  assert.equal(got.home, "H");
  assert.equal(got.timeout, 150);
});
