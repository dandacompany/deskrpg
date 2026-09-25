import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  SetupPortConflictError,
  checkModelHost,
  discoverHost,
  inspectHost,
  installHermesHost,
  prepareHost,
  setWorkerPropagationHost,
} from "./host";
import type { HostExecutor, SetupCandidate } from "./types";
const candidate: SetupCandidate = {
  id: "a".repeat(64),
  label: "Hermes default",
  version: "0.21.1",
  service: "hermes-gateway.service",
  port: 8642,
  pluginInstalled: false,
  pluginEnabled: false,
  pluginVersion: null,
  timezone: null,
  hasToken: false,
};
function fake(responses: unknown[]) {
  const calls: { command: string; args: string[]; input?: string }[] = [];
  const execute: HostExecutor = async (command, args, options) => {
    calls.push({ command, args, input: options?.input });
    const reply = responses.shift();
    if (reply instanceof Error) throw reply;
    return { code: 0, stdout: JSON.stringify(reply), stderr: "" };
  };
  return { execute, calls };
}
test("discovery explicitly projects public metadata and strips unexpected secrets", async () => {
  const f = fake([{ candidates: [{ ...candidate, token: "do-not-return" }] }]);
  assert.deepEqual(await discoverHost(f.execute), [candidate]);
});
test("untrusted candidate IDs are rejected before host execution", async () => {
  const f = fake([]);
  await assert.rejects(inspectHost(f.execute, "../profile"), /invalid_candidate/);
  assert.equal(f.calls.length, 0);
});
test("prepare preserves reused token and verifies before returning private credentials", async () => {
  const f = fake([
    { candidate, pluginStatus: "plugin_absent", changes: ["installing_plugin"] },
    { ok: true },
    { ok: true },
    { ok: true },
    {
      prepared: {
        baseUrl: "http://127.0.0.1:8642",
        token: "existing-private-token",
        profiles: [{ name: "default", token: "existing-private-token" }],
      },
    },
  ]);
  const steps: string[] = [];
  const result = await prepareHost(f.execute, candidate.id, (s) => steps.push(s));
  assert.equal(result.token, "existing-private-token");
  assert.deepEqual(steps, [
    "inspecting",
    "installing_plugin",
    "configuring_api",
    "restarting_gateway",
    "verifying_gateway",
  ]);
  assert.ok(f.calls.every((c) => !JSON.stringify(c.args).includes("existing-private-token")));
});
test("install failure exposes only fixed error code and never continues", async () => {
  const f = fake([
    { candidate, pluginStatus: "plugin_absent", changes: ["installing_plugin"] },
    { error: "plugin_install_failed", detail: "secret=private" },
  ]);
  await assert.rejects(
    prepareHost(f.execute, candidate.id, () => {}),
    /^Error: plugin_install_failed$/,
  );
  assert.equal(f.calls.length, 2);
});
test("port conflicts and unknown helper errors fail closed without raw diagnostics", async () => {
  for (const [error, expected] of [
    ["port_conflict", "port_conflict"],
    ["secret token leaked", "host_operation_failed"],
  ]) {
    const f = fake([{ error }]);
    await assert.rejects(inspectHost(f.execute, candidate.id), new RegExp(`^Error: ${expected}$`));
  }
});
test("cancellation prevents the next mutation", async () => {
  const controller = new AbortController();
  const f = fake([{ candidate, pluginStatus: "plugin_absent", changes: ["installing_plugin"] }]);
  await assert.rejects(
    prepareHost(
      f.execute,
      candidate.id,
      (step) => {
        if (step === "installing_plugin") controller.abort();
      },
      controller.signal,
    ),
    /setup_cancelled/,
  );
  assert.equal(f.calls.length, 1);
});

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  HOST_BOOTSTRAP,
  HOST_HELPER,
  HOST_LAUNCHER,
  HOST_LAUNCHER_PS,
  hostLaunch,
} from "./host-helper";
import { PLUGIN_PIN, PLUGIN_VERSION } from "./pin";
const installedPython = ["venv", ".venv"]
  .map((name) => join(homedir(), ".hermes/hermes-agent", name, "bin/python"))
  .find(existsSync);
function fixture(
  script: string,
  initial: { config?: object; env?: string; hermesVersion?: string | null; plugin?: object } = {},
) {
  const temp = mkdtempSync(join(tmpdir(), "deskrpg-host-test-"));
  const root = join(temp, ".hermes");
  mkdirSync(join(root, "hermes-agent"), { recursive: true });
  writeFileSync(join(root, "config.yaml"), JSON.stringify(initial.config ?? {}));
  writeFileSync(join(root, ".env"), initial.env ?? "");
  writeFileSync(
    join(root, "hermes-agent/pyproject.toml"),
    initial.hermesVersion === null
      ? "[project]\n"
      : `version = "${initial.hermesVersion ?? "0.21.1"}"\n`,
  );
  if (initial.plugin) {
    mkdirSync(join(root, "plugins/deskrpg"), { recursive: true });
    writeFileSync(join(root, "plugins/deskrpg/plugin.yaml"), JSON.stringify(initial.plugin));
  }
  // The portable branch supplies only YAML/env parsing; no Hermes installation or service is needed in CI.
  const portable = installedPython
    ? ""
    : String.raw`
import types, sys, json
sys.modules['yaml'] = types.SimpleNamespace(safe_load=lambda text: json.loads(text) if text else {}, safe_dump=lambda value, **kwargs: json.dumps(value))
def fixture_env(path):
    # Mirrors agent.secret_scope.load_env_file: a missing file is an empty mapping, never an error.
    try:
        text = path.read_text()
    except FileNotFoundError:
        return {}
    return dict(line.split('=',1) for line in text.splitlines() if '=' in line and not line.startswith('#'))
sys.modules['agent'] = types.ModuleType('agent')
sys.modules['agent.secret_scope'] = types.SimpleNamespace(load_env_file=fixture_env)
`;
  const overrides = String.raw`
assert str(ROOT).startswith(os.environ['HOME'] + '/')
production_identity = identity
def fixture_identity(name,home):
    return {'id':hashlib.sha256(str(home).encode()).hexdigest(),'service':'hermes-gateway' + ('' if name == 'default' else '-' + name) + '.service','command':['false'],'pid':0,'warning':None}
identity = fixture_identity
assert_port_owned = lambda public, owner: False
port_listening = lambda port: False
original_main = main
def main(action,candidate_id=None,option=None):
    global LOCK
    try: return original_main(action,candidate_id,option)
    finally:
        if LOCK is not None: LOCK.close(); LOCK = None
`;
  try {
    const result = spawnSync(installedPython ?? "python3", ["-"], {
      input: portable + HOST_HELPER + overrides + script,
      encoding: "utf8",
      env: { ...process.env, HOME: temp, HERMES_HOME: root, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return {
      body: JSON.parse(result.stdout),
      env: readFileSync(join(root, ".env"), "utf8"),
      config: readFileSync(join(root, "config.yaml"), "utf8"),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
test("Python helper preserves a valid existing key and unrelated configuration", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
print(json.dumps(main('configure',id)))
`,
    {
      config: { model: { default: "existing-model" }, gateway: { multiplex_profiles: true } },
      env: "API_SERVER_KEY=existing-valid-token-12345\nOTHER_KEY=keep-me\n",
    },
  );
  assert.deepEqual(result.body, { ok: true });
  assert.equal(result.env, "API_SERVER_KEY=existing-valid-token-12345\nOTHER_KEY=keep-me\n");
  assert.match(result.config, /existing-model/);
});
test("Python helper provisions absent key once and does not alter sibling credentials", () => {
  const result = fixture(
    String.raw`
child = ROOT / 'profiles' / 'sophie'
child.mkdir(parents=True)
(child / '.env').write_text('API_SERVER_KEY=sophie-private-valid-key\n')
id = main('discover')['candidates'][0]['id']
main('configure',id)
first = (ROOT / '.env').read_text()
main('configure',id)
assert first == (ROOT / '.env').read_text()
assert (child / '.env').read_text() == 'API_SERVER_KEY=sophie-private-valid-key\n'
print(json.dumps({'token_length':len(envfile(ROOT)['API_SERVER_KEY'])}))
`,
    { config: { gateway: { multiplex_profiles: true } }, env: "OTHER_KEY=keep-me\n" },
  );
  assert.equal(result.body.token_length, 64);
  assert.match(result.env, /^OTHER_KEY=keep-me\nAPI_SERVER_KEY=[a-f0-9]{64}\n$/);
});
test("Python helper discovers one gateway carrying its profiles without exposing env secrets", () => {
  const result = fixture(
    String.raw`
child = ROOT / 'profiles' / 'sophie'
child.mkdir(parents=True)
(child / '.env').write_text('API_SERVER_KEY=sophie-private-valid-key\n')
(ROOT / 'profiles' / 'Bad Name').mkdir()
print(json.dumps(main('discover')))
`,
    { env: "API_SERVER_KEY=private-default-valid-key\n" },
  );
  // There is only one gateway, default — profiles are not candidates but the content of that candidate.
  assert.equal(result.body.candidates.length, 1);
  assert.equal(result.body.candidates[0].label, "Hermes default");
  assert.deepEqual(result.body.candidates[0].profiles, ["sophie"]);
  assert.equal(result.body.candidates[0].gatewayState, "stopped");
  assert.ok(!JSON.stringify(result.body).includes("private"));
});
test("does not accept a candidate ID that picks a profile folder as the gateway", () => {
  const result = fixture(String.raw`
child = ROOT / 'profiles' / 'sophie'
child.mkdir(parents=True)
entry('configure', hashlib.sha256(str(child).encode()).hexdigest())
`);
  assert.equal(result.body.error, "candidate_changed");
  assert.equal(result.config, "{}");
});
test("gateway status — running, stopped, profile gateway running separately", () => {
  const result = fixture(String.raw`
(ROOT / 'profiles' / 'sophie').mkdir(parents=True)
(ROOT / 'profiles' / 'mia').mkdir(parents=True)
states = {}
port_listening = lambda port: True
states['listening'] = main('discover')['candidates'][0]['gatewayState']
port_listening = lambda port: False
states['stopped'] = main('discover')['candidates'][0]['gatewayState']
def running_profile(name, home):
    owner = fixture_identity(name, home)
    if name == 'mia': owner['pid'] = 4242
    return owner
identity = running_profile
found = main('discover')['candidates'][0]
states['conflict'] = [found['gatewayState'], found['profileGateways']]
print(json.dumps(states))
`);
  assert.deepEqual(result.body, {
    listening: "running",
    stopped: "stopped",
    conflict: ["profile_gateways", ["mia"]],
  });
});
test("Python helper refuses external secret providers and invalid existing key", () => {
  const external = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
entry('configure',id)
`,
    { config: { secrets: { bitwarden: { enabled: true } } } },
  );
  assert.equal(external.body.error, "external_secret_provider");
  assert.equal(external.env, "");
  const invalid = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
entry('configure',id)
`,
    { env: "API_SERVER_KEY=weak\n" },
  );
  assert.equal(invalid.body.error, "api_key_invalid");
  assert.equal(invalid.env, "API_SERVER_KEY=weak\n");
});
test("Python helper stops on a changed candidate and port conflicts before configuration", () => {
  const changed = fixture(String.raw`
entry('configure','a' * 64)
`);
  assert.equal(changed.body.error, "candidate_changed");
  const conflict = fixture(String.raw`
id = main('discover')['candidates'][0]['id']
def conflict(public,owner): fail('port_conflict')
assert_port_owned = conflict
entry('configure',id)
`);
  assert.equal(conflict.body.error, "port_conflict");
  assert.equal(conflict.env, "");
  assert.equal(conflict.config, "{}");
});
test("Python helper pins plugin install and discards subprocess diagnostics on failure", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
def fake_install(argv, **kwargs):
    assert argv[-5:] == ['install', SOURCE, '--ref', PIN, '--enable']
    assert kwargs['env']['HERMES_HOME'] == str(ROOT)
    assert kwargs['stdin'] == subprocess.DEVNULL
    assert kwargs['stdout'] == subprocess.PIPE
    assert '--force' not in argv
    import io
    return type('Result',(),{'stdout':io.BytesIO(b'secret=private'), 'wait':lambda self:1})()
subprocess.Popen = fake_install
entry('install',id)
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.equal(result.body.error, "plugin_install_failed");
});
test("already-ready retry performs verification without install or restart", async () => {
  const f = fake([
    {
      candidate: { ...candidate, hasToken: true, pluginInstalled: true, pluginEnabled: true },
      pluginStatus: "plugin_ready",
      changes: [],
    },
    {
      prepared: { baseUrl: "http://127.0.0.1:8642", token: "existing-private-token", profiles: [] },
    },
  ]);
  const steps: string[] = [];
  await prepareHost(f.execute, candidate.id, (s) => steps.push(s));
  assert.deepEqual(steps, ["inspecting", "verifying_gateway"]);
});
test("Python verifier returns only live profiles authenticated with their own credentials", () => {
  const result = fixture(
    String.raw`
for child, token in [('sophie','sophie-own-valid-token'),('missing',''),('rejected','rejected-own-valid-token')]:
    home = ROOT / 'profiles' / child
    home.mkdir(parents=True)
    (home / '.env').write_text('API_SERVER_KEY=' + token + '\n' if token else '')
assert_port_owned = lambda public, owner: True
def live(port,token,path):
    if path == '/deskrpg/info':
        assert token == 'default-own-valid-token'
        return 200, {'plugin':'deskrpg','version':'0.5.0'}
    if path == '/deskrpg/profiles': return 200, {'profiles':[{'name':n} for n in ('default','sophie','missing','rejected','../escape')]}
    if path == '/v1/models':
        assert token == 'default-own-valid-token'
        return 200, {'data':[]}
    if path == '/p/sophie/v1/models':
        assert token == 'sophie-own-valid-token'
        return 200, {'data':[]}
    return 401, None
request = live
id = main('discover')['candidates'][0]['id']
print(json.dumps(main('verify',id)))
`,
    {
      config: { gateway: { multiplex_profiles: true } },
      env: "API_SERVER_KEY=default-own-valid-token\n",
    },
  );
  assert.deepEqual(result.body.prepared.profiles, [
    { name: "default", token: "default-own-valid-token" },
    { name: "sophie", token: "sophie-own-valid-token" },
  ]);
});
test("Python restart invokes only the freshly identified selected service", () => {
  const result = fixture(
    String.raw`
def scoped_identity(name,home):
    result = fixture_identity(name,home)
    result['command'] = ['systemctl','--user','restart',result['service']]
    return result
identity = scoped_identity
calls = []
def restart(argv,timeout):
    calls.append(argv)
    return type('Result',(),{'returncode':0})()
run = restart
id = main('discover')['candidates'][0]['id']
main('restart',id)
print(json.dumps(calls))
`,
    {
      config: { gateway: { multiplex_profiles: true } },
      env: "API_SERVER_KEY=default-own-valid-token\n",
    },
  );
  assert.deepEqual(result.body, [["systemctl", "--user", "restart", "hermes-gateway.service"]]);
});
// --- Restart limit: wait for the gateway's graceful shutdown (drain) ------------------------------------
// Hermes units have TimeoutStopSec (default 70s, longer depending on cron drain settings); launchd has ExitTimeOut 60s.
// The old 25s limit reported successful restarts as host_operation_failed (observed shutdown: 31s).
test("restart waits for the service stop limit plus startup slack (floor 90, cap 300s)", () => {
  const result = fixture(
    String.raw`
seen = []
def capture(argv, timeout):
    seen.append(timeout)
    return type('Result',(),{'returncode':0})()
run = capture
id = main('discover')['candidates'][0]['id']
for stop in (70, None, 1000, 10):
    def scoped(name, home, stop=stop):
        result = fixture_identity(name, home)
        result['stop'] = stop
        return result
    identity = scoped
    main('restart', id)
print(json.dumps(seen))
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, [100, 90, 300, 90]);
});
test("a slow restart that finishes within the limit is a success", () => {
  const result = fixture(
    String.raw`
def slow(name, home):
    result = fixture_identity(name, home)
    result['command'] = [sys.executable, '-c', 'import time; time.sleep(1.5)']
    return result
identity = slow
id = main('discover')['candidates'][0]['id']
entry('restart', id)
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, { ok: true });
});
test("a restart exceeding the limit is gateway_restart_failed, not a causeless host_operation_failed", () => {
  const result = fixture(
    String.raw`
RESTART_MIN = 1
RESTART_START_MARGIN = 0
def hung(name, home):
    result = fixture_identity(name, home)
    result['command'] = [sys.executable, '-c', 'import time; time.sleep(30)']
    result['stop'] = 0
    return result
identity = hung
id = main('discover')['candidates'][0]['id']
entry('restart', id)
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, { error: "gateway_restart_failed" });
});
test("stop limit is read from TimeoutStopSec in the Hermes-written unit and ExitTimeOut in the plist", () => {
  const result = fixture(
    String.raw`
print(json.dumps([
    unit_stop_seconds('[Service]\nExecStart=x\nTimeoutStopSec=70\n'),
    unit_stop_seconds('[Service]\nTimeoutStopSec=190\n'),
    unit_stop_seconds('[Service]\nExecStart=x\n'),
    unit_stop_seconds('[Service]\nTimeoutStopSec=1min\n'),
    plist_stop_seconds({'ExitTimeOut': 60}),
    plist_stop_seconds({}),
    plist_stop_seconds({'ExitTimeOut': True}),
]))
`,
  );
  assert.deepEqual(result.body, [70, 190, null, null, 60, null, null]);
});
test("the outer limit of the restart call is more generous than the helper's maximum restart limit", async () => {
  const seen: (number | undefined)[] = [];
  const execute: HostExecutor = async (_command, _args, options) => {
    seen.push(options?.timeoutMs);
    const action = JSON.parse(options!.input!).action;
    const reply =
      action === "inspect"
        ? {
            candidate: { ...candidate, pluginInstalled: true, pluginEnabled: true, hasToken: true },
            pluginStatus: "plugin_ready",
            changes: ["restarting_gateway"],
          }
        : action === "verify"
          ? {
              prepared: {
                baseUrl: "http://127.0.0.1:8642",
                token: "existing-private-token",
                profiles: [],
              },
            }
          : { ok: true };
    return { code: 0, stdout: JSON.stringify(reply), stderr: "" };
  };
  const steps: string[] = [];
  await prepareHost(execute, candidate.id, (s) => steps.push(s));
  const restartIndex = steps.indexOf("restarting_gateway");
  assert.ok(restartIndex > 0);
  // Helper cap of 300s + python startup/lock slack. Anything shorter cuts off outside first and the cause turns into
  // command_timeout.
  assert.ok((seen[restartIndex] ?? 0) >= 330_000, String(seen[restartIndex]));
});
test("SSH host-key failures retain an actionable sanitized code", async () => {
  const f = fake([new Error("ssh_host_key_failed")]);
  await assert.rejects(discoverHost(f.execute), /^Error: ssh_host_key_failed$/);
});
test("external secret provider can coexist with an existing locally stored key verified against the owning service", () => {
  const result = fixture(
    String.raw`
assert_port_owned = lambda public, owner: True
request = lambda port, token, path: (200, {'data':[]}) if token == 'existing-valid-token-12345' and path == '/v1/models' else (401,None)
id = main('discover')['candidates'][0]['id']
print(json.dumps(main('configure',id)))
`,
    {
      config: { secrets: { bitwarden: { enabled: true } }, gateway: { multiplex_profiles: true } },
      env: "API_SERVER_KEY=existing-valid-token-12345\n",
    },
  );
  assert.deepEqual(result.body, { ok: true });
  assert.equal(result.env, "API_SERVER_KEY=existing-valid-token-12345\n");
  assert.match(result.config, /bitwarden/);
});
test("host-wide mutation lock rejects overlapping retries before any configuration change", () => {
  const result = fixture(String.raw`
import fcntl
held = open(ROOT / '.deskrpg-setup.lock','w')
fcntl.flock(held.fileno(),fcntl.LOCK_EX | fcntl.LOCK_NB)
id = main('discover')['candidates'][0]['id']
entry('configure',id)
`);
  assert.equal(result.body.error, "host_busy");
  assert.equal(result.env, "");
  assert.equal(result.config, "{}");
});
test("bootstrap timeout kills the owned installer process group, including descendants", () => {
  const temp = mkdtempSync(join(tmpdir(), "deskrpg-watchdog-test-"));
  let ownedPids: number[] = [];
  try {
    // Build a stdlib-only venv outside the watchdog window. A fresh executable shell
    // shim has cold-launch overhead; a bare symlink also breaks relocatable Python builds.
    const venv = spawnSync(
      "python3",
      ["-m", "venv", "--without-pip", join(temp, ".hermes/hermes-agent/venv")],
      {
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(venv.status, 0, venv.stderr);
    const script = String.raw`
import json, os, pathlib, subprocess, sys, time
child = subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])
(pathlib.Path.home() / 'owned-test-pid').write_text(json.dumps([os.getpid(), child.pid]))
time.sleep(30)
`;
    const result = spawnSync("python3", ["-c", HOST_BOOTSTRAP], {
      env: { ...process.env, HOME: temp },
      encoding: "utf8",
      // This test is about killing the owned group, not about the watchdog's exact budget. The
      // budget has to cover a python3 cold start plus a descendant spawn on a machine running
      // several suites at once (2s lost that race), so it is generous; the child sleeps 30s, so a
      // survivor is still caught.
      input: JSON.stringify({ action: "install", timeout: 6, script }),
      timeout: 30000,
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { error: "host_operation_failed" });
    const pidFile = join(temp, "owned-test-pid");
    assert.ok(
      existsSync(pidFile),
      "helper must start and spawn a descendant before the watchdog fires",
    );
    ownedPids = JSON.parse(readFileSync(pidFile, "utf8"));
    assert.equal(ownedPids.length, 2);
    for (const pid of ownedPids) {
      assert.ok(Number.isInteger(pid) && pid > 0);
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf8",
      }).stdout.trim();
      assert.ok(
        state === "" || state.startsWith("Z"),
        `owned process ${pid} survived watchdog: ${state}`,
      );
    }
  } finally {
    for (const pid of ownedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already reaped */
      }
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
test("launchd rejects loaded argv that differ from the reviewed disk service definition", () => {
  const result = fixture(String.raw`
sys.platform = 'darwin'
identity = production_identity
path = pathlib.Path.home() / 'Library' / 'LaunchAgents' / 'ai.hermes.gateway.plist'
path.parent.mkdir(parents=True)
args = [sys.executable,'-m','hermes_cli.main','gateway','run']
path.write_bytes(plistlib.dumps({'Label':'ai.hermes.gateway','ProgramArguments':args,'EnvironmentVariables':{'HERMES_HOME':str(ROOT)},'RunAtLoad':True}))
loaded = 'arguments = {\n' + '\n'.join([sys.executable,'-m','hermes_cli.main','--profile','sophie','gateway','run']) + '\n}\nHERMES_HOME => ' + str(ROOT) + '\npid = 123\n'
def state(argv,timeout=8,env=None):
    return type('Result',(),{'returncode':0 if argv[2].startswith('gui/') else 113,'stdout':loaded})()
run = state
print(json.dumps(main('discover')))
`);
  assert.equal(result.body.candidates[0].warning, "service_identity_mismatch");
});
test("inspection projects only profile names and key availability", async () => {
  const f = fake([
    {
      candidate,
      pluginStatus: "unknown",
      changes: [],
      profiles: [{ name: "sophie", hasToken: true, token: "private-profile-token" }],
    },
  ]);
  const result = await inspectHost(f.execute, candidate.id);
  assert.deepEqual(result.profiles, [{ name: "sophie", hasToken: true }]);
  assert.ok(!JSON.stringify(result).includes("private-profile-token"));
});
test("systemd verifies exact live argv and disk unit before authorizing a selected restart", () => {
  const result = fixture(String.raw`
sys.platform = 'linux'
identity = production_identity
path = pathlib.Path.home() / '.config' / 'systemd' / 'user' / 'hermes-gateway.service'
path.parent.mkdir(parents=True)
args = [sys.executable,'-m','hermes_cli.main','gateway','run']
path.write_text('[Service]\nExecStart=' + shlex.join(args) + '\nEnvironment="HERMES_HOME=' + str(ROOT) + '"\n')
wrong = [sys.executable,'-m','hermes_cli.main','--profile','sophie','gateway','run']
def state(argv,timeout=8,env=None):
    text = 'FragmentPath=' + str(path) + '\nDropInPaths=\nMainPID=123\nEnvironment=HERMES_HOME=' + str(ROOT) + '\nExecStart={ path=' + sys.executable + ' ; argv[]=' + shlex.join(wrong) + ' ; }\n'
    return type('Result',(),{'returncode':0,'stdout':text})()
run = state
bad = main('discover')['candidates'][0]
wrong = args
good = main('discover')['candidates'][0]
print(json.dumps({'bad':bad,'good':good}))
`);
  assert.equal(result.body.bad.warning, "service_identity_mismatch");
  assert.equal(result.body.good.warning, undefined);
});
test("inspection removes the external-provider warning after authenticating the existing local key", () => {
  const result = fixture(
    String.raw`
assert_port_owned = lambda public,owner: True
def live(port,token,path):
    assert token == 'existing-valid-token-12345'
    if path == '/v1/models': return 200, {'data':[]}
    if path == '/deskrpg/info': return 200, {'plugin':'deskrpg','version':'0.5.0'}
    return 404, None
request = live
id = main('discover')['candidates'][0]['id']
print(json.dumps(main('inspect',id)))
`,
    {
      config: { secrets: { bitwarden: { enabled: true } }, gateway: { multiplex_profiles: true } },
      env: "API_SERVER_KEY=existing-valid-token-12345\n",
    },
  );
  assert.equal(result.body.pluginStatus, "plugin_ready");
  assert.equal(result.body.candidate.warning, undefined);
  assert.equal(result.env, "API_SERVER_KEY=existing-valid-token-12345\n");
});
test("inspection marks every safely provisionable profile, owner and siblings alike", () => {
  const result = fixture(
    String.raw`
child = ROOT / 'profiles' / 'sophie'
child.mkdir(parents=True)
id = main('discover')['candidates'][0]['id']
print(json.dumps(main('inspect',id)))
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  // Contract 2: a sibling profile is also an issuance target if it has no key and doesn't use an external provider.
  assert.deepEqual(result.body.profiles, [
    { name: "default", hasToken: false, canProvision: true },
    { name: "sophie", hasToken: false, canProvision: true },
  ]);
  assert.equal(result.env, "");
});
test("inspection does not offer provisioning through an unavailable external secret provider", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
print(json.dumps(main('inspect',id)))
`,
    { config: { secrets: { bitwarden: { enabled: true } } } },
  );
  assert.deepEqual(result.body.profiles, [{ name: "default", hasToken: false }]);
  assert.equal(result.body.candidate.warning, "external_secret_provider");
  assert.equal(result.env, "");
});
test("inspection safely forwards optional provisioning capability without credentials", async () => {
  const f = fake([
    {
      candidate,
      pluginStatus: "unknown",
      changes: [],
      profiles: [
        { name: "sophie", hasToken: false, canProvision: true, token: "private-profile-token" },
      ],
    },
  ]);
  const result = await inspectHost(f.execute, candidate.id);
  assert.deepEqual(result.profiles, [{ name: "sophie", hasToken: false, canProvision: true }]);
  assert.ok(!JSON.stringify(result).includes("private-profile-token"));
});

for (const [diagnostic, expected] of [
  ["Security scan: BLOCKED. secret=private", "plugin_security_review_required"],
  ["fatal: Repository not found. secret=private", "plugin_source_unavailable"],
  ["unexpected secret=private", "plugin_install_failed"],
] as const) {
  test(`installer reports only safe code: ${expected}`, () => {
    const result = fixture(
      String.raw`
id = main('discover')['candidates'][0]['id']
import io
def fake_install(argv, **kwargs):
    assert '--force' not in argv
    return type('Result',(),{'stdout':io.BytesIO(${JSON.stringify(diagnostic)}.encode()), 'wait':lambda self:1})()
subprocess.Popen = fake_install
entry('install',id)
`,
      { config: { gateway: { multiplex_profiles: true } } },
    );
    assert.deepEqual(result.body, { error: expected });
  });
}
test("installer bounds diagnostics and terminates excessive output", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
import io
class Child:
    stdout = io.BytesIO(b'x' * 262145)
    killed = False
    def kill(self): self.killed = True
    def wait(self):
        assert self.killed
        return 1
subprocess.Popen = lambda *args, **kwargs: Child()
entry('install',id)
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, { error: "output_limit" });
});

test("rejects a Hermes version below the floor in the prepare step", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
entry('configure',id)
`,
    { config: { gateway: { multiplex_profiles: true } }, hermesVersion: "0.21.0" },
  );
  assert.equal(result.body.error, "hermes_version_unsupported");
  assert.equal(result.env, "");
});
test("ignores a non-numeric tail of the Hermes version in comparison", () => {
  const result = fixture(
    String.raw`
print(json.dumps({'candidate': main('discover')['candidates'][0], 'configure': main('configure',main('discover')['candidates'][0]['id'])}))
`,
    { config: { gateway: { multiplex_profiles: true } }, hermesVersion: "0.21.1rc1" },
  );
  assert.deepEqual(result.body.configure, { ok: true });
  assert.equal(result.body.candidate.warning, undefined);
});
test("does not block when the Hermes version can't be read, only leaves a warning", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
print(json.dumps({'candidate': main('discover')['candidates'][0], 'configure': main('configure',id)}))
`,
    { config: { gateway: { multiplex_profiles: true } }, hermesVersion: null },
  );
  assert.equal(result.body.candidate.version, "unknown");
  assert.equal(result.body.candidate.warning, "hermes_version_unknown");
  assert.deepEqual(result.body.configure, { ok: true });
});
test("an outdated plugin puts updating_plugin into changes", () => {
  const result = fixture(
    String.raw`
print(json.dumps(main('inspect',main('discover')['candidates'][0]['id'])))
`,
    {
      config: { gateway: { multiplex_profiles: true }, plugins: { enabled: ["deskrpg"] } },
      plugin: { name: "deskrpg", version: "0.5.0" },
    },
  );
  assert.equal(result.body.candidate.pluginVersion, "0.5.0");
  assert.ok(result.body.changes.includes("updating_plugin"));
  assert.ok(!result.body.changes.includes("installing_plugin"));
  assert.ok(result.body.changes.includes("restarting_gateway"));
});
test("no update step when the plugin version is equal or higher", () => {
  for (const version of [PLUGIN_VERSION, "99.0.0"]) {
    const result = fixture(
      String.raw`
print(json.dumps(main('inspect',main('discover')['candidates'][0]['id'])))
`,
      {
        config: { gateway: { multiplex_profiles: true }, plugins: { enabled: ["deskrpg"] } },
        plugin: { name: "deskrpg", version },
      },
    );
    assert.equal(result.body.candidate.pluginVersion, version);
    assert.ok(!result.body.changes.includes("updating_plugin"));
    assert.ok(!result.body.changes.includes("installing_plugin"));
  }
});
test("updating an outdated plugin reinstalls the pinned commit with --force and re-reads the version to confirm", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
import io
calls = []
def fake_install(argv, **kwargs):
    calls.append(argv)
    assert kwargs['env']['HERMES_HOME'] == str(ROOT)
    (ROOT / 'plugins' / 'deskrpg' / 'plugin.yaml').write_text(json.dumps({'name':'deskrpg','version':PLUGIN_VERSION}))
    return type('Result',(),{'stdout':io.BytesIO(b''), 'wait':lambda self:0})()
subprocess.Popen = fake_install
result = main('install',id)
print(json.dumps({'result':result,'argv':calls[0][-6:]}))
`,
    {
      config: { gateway: { multiplex_profiles: true }, plugins: { enabled: ["deskrpg"] } },
      plugin: { name: "deskrpg", version: "0.5.0" },
    },
  );
  assert.deepEqual(result.body.result, { ok: true });
  assert.deepEqual(result.body.argv, [
    "install",
    "https://github.com/dandacompany/deskrpg-hermes-plugin",
    "--ref",
    PLUGIN_PIN,
    "--force",
    "--enable",
  ]);
});
test("a failed update reports only plugin_update_failed and --force does not bypass the security scan", () => {
  for (const [diagnostic, expected] of [
    ["unexpected secret=private", "plugin_update_failed"],
    ["Security scan: BLOCKED. secret=private", "plugin_security_review_required"],
  ] as const) {
    const result = fixture(
      String.raw`
id = main('discover')['candidates'][0]['id']
import io
def fake_install(argv, **kwargs):
    assert '--force' in argv
    return type('Result',(),{'stdout':io.BytesIO(DIAGNOSTIC.encode()), 'wait':lambda self:1})()
subprocess.Popen = fake_install
entry('install',id)
`.replace("DIAGNOSTIC", JSON.stringify(diagnostic)),
      {
        config: { gateway: { multiplex_profiles: true }, plugins: { enabled: ["deskrpg"] } },
        plugin: { name: "deskrpg", version: "0.5.0" },
      },
    );
    assert.deepEqual(result.body, { error: expected });
  }
});
test("treats it as an update failure when the update command succeeds but the version is unchanged", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
import io
subprocess.Popen = lambda argv, **kwargs: type('Result',(),{'stdout':io.BytesIO(b''), 'wait':lambda self:0})()
entry('install',id)
`,
    {
      config: { gateway: { multiplex_profiles: true }, plugins: { enabled: ["deskrpg"] } },
      plugin: { name: "deskrpg", version: "0.5.0" },
    },
  );
  assert.deepEqual(result.body, { error: "plugin_update_failed" });
});
const MANUAL = String.raw`
state = {'installed': False}
def manual_identity(name,home):
    result = fixture_identity(name,home)
    if not state['installed']:
        result['service'] = 'manual'
        result['command'] = None
        result['warning'] = 'managed_service_required'
    return result
identity = manual_identity
`;
test("installing_service goes into changes when there is no service unit", () => {
  const result = fixture(
    MANUAL +
      String.raw`
print(json.dumps(main('inspect',main('discover')['candidates'][0]['id'])))
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body.changes.slice(0, 2), ["installing_service", "installing_plugin"]);
  assert.ok(result.body.changes.includes("restarting_gateway"));
});
test("service install calls only the Hermes CLI and never writes the unit file directly", () => {
  const result = fixture(
    MANUAL +
      String.raw`
id = main('discover')['candidates'][0]['id']
import io
calls = []
def fake(argv, **kwargs):
    calls.append(argv)
    state['installed'] = True
    return type('Result',(),{'stdout':io.BytesIO(b''), 'wait':lambda self:0})()
subprocess.Popen = fake
result = main('install-service',id)
written = sorted(str(p.relative_to(pathlib.Path.home())) for p in pathlib.Path.home().rglob('*') if p.is_file())
print(json.dumps({'result':result,'argv':calls[0][1:],'written':written}))
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.equal(result.body.result.ok, true);
  // Creating the unit changes the candidate id (a hash of the definition) — the new id must be returned for the
  // following steps to work.
  assert.match(result.body.result.candidateId, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.body.argv, [
    "-m",
    "hermes_cli.main",
    "--profile",
    "default",
    "gateway",
    "install",
  ]);
  assert.ok(!result.body.written.some((p: string) => /LaunchAgents|systemd/.test(p)));
});
test("stops with service_install_failed when there is still no unit after service install", () => {
  const result = fixture(
    MANUAL +
      String.raw`
id = main('discover')['candidates'][0]['id']
import io
subprocess.Popen = lambda argv, **kwargs: type('Result',(),{'stdout':io.BytesIO(b''), 'wait':lambda self:0})()
entry('install-service',id)
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, { error: "service_install_failed" });
});
test("on Windows a gateway without its scheduled task fails with the Windows-specific code", () => {
  // Upstream falls back to a Startup-folder entry when it cannot register the scheduled task. That entry
  // cannot be stopped, so the generic "no managed service" copy gave the user no way out.
  const result = fixture(
    MANUAL +
      String.raw`
id = main('discover')['candidates'][0]['id']
sys.platform = 'win32'
entry('install',id)
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, { error: "windows_scheduled_task_missing" });
});
test("off Windows the same gateway keeps the generic managed-service code", () => {
  const result = fixture(
    MANUAL +
      String.raw`
id = main('discover')['candidates'][0]['id']
sys.platform = 'linux'
entry('install',id)
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, { error: "managed_service_required" });
});
test("on Windows a service install that leaves only the Startup-folder entry names the missing scheduled task", () => {
  const result = fixture(
    MANUAL +
      String.raw`
id = main('discover')['candidates'][0]['id']
import io
subprocess.Popen = lambda argv, **kwargs: type('Result',(),{'stdout':io.BytesIO(b''), 'wait':lambda self:0})()
sys.platform = 'win32'
entry('install-service',id)
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, { error: "windows_scheduled_task_missing" });
});
test("does not overwrite an existing timezone", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
print(json.dumps({'candidate': main('discover')['candidates'][0], 'result': main('set-timezone',id,'Asia/Seoul')}))
`,
    { config: { gateway: { multiplex_profiles: true }, timezone: "Europe/Paris" } },
  );
  assert.equal(result.body.candidate.timezone, "Europe/Paris");
  assert.deepEqual(result.body.result, { ok: true });
  assert.match(result.config, /Europe\/Paris/);
  assert.ok(!result.config.includes("Asia/Seoul"));
});
test("puts in the requested IANA name when the timezone is empty", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
print(json.dumps({'candidate': main('discover')['candidates'][0], 'result': main('set-timezone',id,'Asia/Seoul'), 'stored': config(ROOT).get('timezone')}))
`,
    { config: { gateway: { multiplex_profiles: true }, model: { default: "keep-me" } } },
  );
  assert.equal(result.body.candidate.timezone, null);
  assert.deepEqual(result.body.result, { ok: true });
  assert.equal(result.body.stored, "Asia/Seoul");
  assert.match(result.config, /keep-me/);
});
test("the host also rejects an invalid timezone as timezone_invalid", () => {
  for (const value of ["Asia Seoul", "/Asia/Seoul", "", "9Asia/Seoul", "A" + "b".repeat(70)]) {
    const result = fixture(
      String.raw`
id = main('discover')['candidates'][0]['id']
entry('set-timezone',id,${JSON.stringify(value)})
`,
      { config: { gateway: { multiplex_profiles: true } } },
    );
    assert.deepEqual(result.body, { error: "timezone_invalid" });
    assert.ok(!result.config.includes("timezone"));
  }
});
test("update, service install and timezone steps run in contract order", async () => {
  const stale = {
    ...candidate,
    pluginInstalled: true,
    pluginEnabled: true,
    pluginVersion: "0.5.0",
    hasToken: true,
  };
  const f = fake([
    {
      candidate: stale,
      pluginStatus: "plugin_ready",
      changes: ["installing_service", "updating_plugin", "configuring_api"],
    },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true },
    {
      prepared: { baseUrl: "http://127.0.0.1:8642", token: "existing-private-token", profiles: [] },
    },
  ]);
  const steps: string[] = [];
  await prepareHost(f.execute, candidate.id, (s) => steps.push(s), undefined, "Asia/Seoul");
  assert.deepEqual(steps, [
    "inspecting",
    "installing_service",
    "updating_plugin",
    "configuring_api",
    "setting_timezone",
    "restarting_gateway",
    "verifying_gateway",
  ]);
  const actions = f.calls.map((c) => JSON.parse(c.input!).action);
  assert.deepEqual(actions, [
    "inspect",
    "install-service",
    "install",
    "configure",
    "set-timezone",
    "restart",
    "verify",
  ]);
  assert.ok(f.calls[4].input!.includes("Asia/Seoul"));
});
test("skips the configure step when the candidate already has a timezone", async () => {
  const f = fake([
    {
      candidate: {
        ...candidate,
        pluginInstalled: true,
        pluginEnabled: true,
        pluginVersion: "0.6.0",
        hasToken: true,
        timezone: "Europe/Paris",
      },
      pluginStatus: "plugin_ready",
      changes: [],
    },
    {
      prepared: { baseUrl: "http://127.0.0.1:8642", token: "existing-private-token", profiles: [] },
    },
  ]);
  const steps: string[] = [];
  await prepareHost(f.execute, candidate.id, (s) => steps.push(s), undefined, "Asia/Seoul");
  assert.deepEqual(steps, ["inspecting", "verifying_gateway"]);
});
// --- Worker propagation opt-in (plugin 0.16.0) ------------------------------------------------
// The wizard turns the operator setting `plugins.entries.deskrpg.worker_propagation` (or DESKRPG_WORKER_PROPAGATION
// in the root .env) on and off. The plugin only reads it. Inspection reports "is there an already-linked profile" to decide carry-over.
test("inspection carries the worker propagation state and whether linked profiles exist", () => {
  const result = fixture(
    String.raw`
before = main('discover')['candidates'][0]
child = ROOT / 'profiles' / 'sophie'
(child / 'plugins').mkdir(parents=True)
real = ROOT / 'plugins' / 'deskrpg'
real.mkdir(parents=True)
(child / 'plugins' / 'deskrpg').symlink_to(real)
after = main('discover')['candidates'][0]
print(json.dumps({'before': [before['workerPropagation'], before['workerLinked']], 'after': [after['workerPropagation'], after['workerLinked']]}))
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body.before, ["disabled", false]);
  assert.deepEqual(result.body.after, ["disabled", true]);
});
test("a plugin folder installed directly in a profile does not count as a link", () => {
  const result = fixture(
    String.raw`
(ROOT / 'profiles' / 'sophie' / 'plugins' / 'deskrpg').mkdir(parents=True)
print(json.dumps(main('discover')['candidates'][0]['workerLinked']))
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.equal(result.body, false);
});
test("propagation is enabled when the root config value or the .env variable is on", () => {
  const byConfig = fixture(
    String.raw`print(json.dumps(main('discover')['candidates'][0]['workerPropagation']))`,
    {
      config: {
        gateway: { multiplex_profiles: true },
        plugins: { entries: { deskrpg: { worker_propagation: true } } },
      },
    },
  );
  assert.equal(byConfig.body, "enabled");
  for (const [value, expected] of [
    ["on", "enabled"],
    ["TRUE", "enabled"],
    ["0", "disabled"],
  ]) {
    const byEnv = fixture(
      String.raw`print(json.dumps(main('discover')['candidates'][0]['workerPropagation']))`,
      {
        config: { gateway: { multiplex_profiles: true } },
        env: `DESKRPG_WORKER_PROPAGATION=${value}\n`,
      },
    );
    assert.equal(byEnv.body, expected, value);
  }
});
test("malformed plugins.entries does not block inspection and reads as disabled", () => {
  const result = fixture(
    String.raw`print(json.dumps(main('discover')['candidates'][0]['workerPropagation']))`,
    { config: { gateway: { multiplex_profiles: true }, plugins: { entries: "oops" } } },
  );
  assert.equal(result.body, "disabled");
});
test("set-worker-propagation writes on to the root config and preserves existing keys", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
out = main('set-worker-propagation', id, 'true')
stored = config(ROOT)
print(json.dumps({'out': out, 'plugins': stored.get('plugins'), 'model': stored.get('model')}))
`,
    {
      config: {
        gateway: { multiplex_profiles: true },
        model: { default: "keep-me" },
        plugins: { enabled: ["deskrpg"], entries: { other: { x: 1 }, deskrpg: { note: "keep" } } },
      },
    },
  );
  assert.deepEqual(result.body.out, { ok: true, propagation: "enabled" });
  assert.deepEqual(result.body.plugins, {
    enabled: ["deskrpg"],
    entries: { other: { x: 1 }, deskrpg: { note: "keep", worker_propagation: true } },
  });
  assert.deepEqual(result.body.model, { default: "keep-me" });
});
test("set-worker-propagation false writes off, and doesn't write when the value is already the same", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
off = main('set-worker-propagation', id, 'false')
stored = config(ROOT)['plugins']['entries']['deskrpg']['worker_propagation']
mtime = (ROOT / 'config.yaml').stat().st_mtime_ns
again = main('set-worker-propagation', id, 'false')
print(json.dumps({'off': off, 'stored': stored, 'again': again, 'untouched': mtime == (ROOT / 'config.yaml').stat().st_mtime_ns}))
`,
    {
      config: {
        gateway: { multiplex_profiles: true },
        plugins: { entries: { deskrpg: { worker_propagation: true } } },
      },
    },
  );
  assert.deepEqual(result.body.off, { ok: true, propagation: "disabled" });
  assert.equal(result.body.stored, false);
  assert.deepEqual(result.body.again, { ok: true, propagation: "disabled" });
  assert.equal(result.body.untouched, true);
});
test("reports the actual enabled state as-is when writing off but the .env variable keeps it on", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
print(json.dumps(main('set-worker-propagation', id, 'false')))
`,
    { config: { gateway: { multiplex_profiles: true } }, env: "DESKRPG_WORKER_PROPAGATION=1\n" },
  );
  assert.deepEqual(result.body, { ok: true, propagation: "enabled" });
});
test("set-worker-propagation rejects invalid values and malformed config shapes and writes nothing", () => {
  for (const option of ["yes", "", "True", "1"]) {
    const result = fixture(
      String.raw`
id = main('discover')['candidates'][0]['id']
entry('set-worker-propagation', id, ${JSON.stringify(option)})
`,
      { config: { gateway: { multiplex_profiles: true } } },
    );
    assert.deepEqual(result.body, { error: "invalid_host_operation" }, option);
    assert.ok(!result.config.includes("worker_propagation"));
  }
  const shaped = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
entry('set-worker-propagation', id, 'true')
`,
    { config: { gateway: { multiplex_profiles: true }, plugins: { entries: ["x"] } } },
  );
  assert.deepEqual(shaped.body, { error: "invalid_host_config" });
  assert.ok(!shaped.config.includes("worker_propagation"));
});
test("enabling worker propagation applies it with one restart after the configure step", async () => {
  const ready = {
    ...candidate,
    pluginInstalled: true,
    pluginEnabled: true,
    pluginVersion: "0.16.0",
    hasToken: true,
    workerPropagation: "disabled",
    workerLinked: false,
  };
  const f = fake([
    { candidate: ready, pluginStatus: "plugin_ready", changes: [] },
    { ok: true, propagation: "enabled" },
    { ok: true },
    {
      prepared: { baseUrl: "http://127.0.0.1:8642", token: "existing-private-token", profiles: [] },
    },
  ]);
  const steps: string[] = [];
  const prepared = await prepareHost(
    f.execute,
    candidate.id,
    (s) => steps.push(s),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  assert.deepEqual(steps, [
    "inspecting",
    "setting_worker_propagation",
    "restarting_gateway",
    "verifying_gateway",
  ]);
  const inputs = f.calls.map((c) => JSON.parse(c.input!));
  assert.deepEqual(
    inputs.map((i) => i.action),
    ["inspect", "set-worker-propagation", "restart", "verify"],
  );
  assert.match(inputs[1].script, /entry\("set-worker-propagation", "a{64}", "true"\)/);
  assert.equal(prepared.workerPropagation, "enabled");
});
test("no step and no restart when worker propagation is already in the desired state", async () => {
  const f = fake([
    {
      candidate: {
        ...candidate,
        pluginInstalled: true,
        pluginEnabled: true,
        hasToken: true,
        workerPropagation: "enabled",
        workerLinked: true,
      },
      pluginStatus: "plugin_ready",
      changes: [],
    },
    {
      prepared: { baseUrl: "http://127.0.0.1:8642", token: "existing-private-token", profiles: [] },
    },
  ]);
  const steps: string[] = [];
  const prepared = await prepareHost(
    f.execute,
    candidate.id,
    (s) => steps.push(s),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  assert.deepEqual(steps, ["inspecting", "verifying_gateway"]);
  assert.equal(prepared.workerPropagation, "enabled");
});
test("the candidate carries worker propagation state and link presence only after the shape check", async () => {
  const f = fake([
    {
      candidates: [
        { ...candidate, workerPropagation: "enabled", workerLinked: true },
        { ...candidate, workerPropagation: "maybe", workerLinked: "yes" },
      ],
    },
  ]);
  const [good, odd] = await discoverHost(f.execute);
  assert.equal(good.workerPropagation, "enabled");
  assert.equal(good.workerLinked, true);
  assert.equal(odd.workerPropagation, undefined);
  assert.equal(odd.workerLinked, undefined);
});
test("setWorkerPropagationHost sends only true/false and returns the resulting state", async () => {
  const f = fake([{ ok: true, propagation: "disabled" }]);
  assert.equal(await setWorkerPropagationHost(f.execute, candidate.id, false), "disabled");
  assert.match(JSON.parse(f.calls[0].input!).script, /"set-worker-propagation", "a{64}", "false"/);
  const bad = fake([{ ok: true, propagation: "sideways" }]);
  await assert.rejects(
    setWorkerPropagationHost(bad.execute, candidate.id, true),
    /^Error: host_operation_failed$/,
  );
  const failing = fake([{ error: "worker_propagation_write_failed" }]);
  await assert.rejects(
    setWorkerPropagationHost(failing.execute, candidate.id, true),
    /^Error: worker_propagation_write_failed$/,
  );
});
test("rejects an invalid timezone before running the host", async () => {
  const f = fake([
    {
      candidate: { ...candidate, pluginInstalled: true, pluginEnabled: true, hasToken: true },
      pluginStatus: "plugin_ready",
      changes: [],
    },
  ]);
  await assert.rejects(
    prepareHost(f.execute, candidate.id, () => {}, undefined, "Asia Seoul"),
    /^Error: timezone_invalid$/,
  );
  assert.equal(f.calls.length, 1);
});

// --- Contract 2: profile creation and key issuance -------------------------------------------------
test("the host rejects invalid names and reserved words before running", () => {
  for (const name of ["Sophie", "-bad", "so phie", "a".repeat(65), "", "default", "root"]) {
    const result = fixture(
      String.raw`
subprocess.Popen = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('must not run'))
entry('create-profile',main('discover')['candidates'][0]['id'],${JSON.stringify(JSON.stringify({ name }))})
`,
      { config: { gateway: { multiplex_profiles: true } } },
    );
    assert.deepEqual(result.body, { error: "profile_name_invalid" });
  }
});
test("does not create the profile when the description exceeds 200 characters or contains a newline", () => {
  for (const description of ["x".repeat(201), "두\n줄"]) {
    const result = fixture(
      String.raw`
subprocess.Popen = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('must not run'))
entry('create-profile',main('discover')['candidates'][0]['id'],OPTION)
`.replace("OPTION", JSON.stringify(JSON.stringify({ name: "sophie", description }))),
      { config: { gateway: { multiplex_profiles: true } } },
    );
    assert.deepEqual(result.body, { error: "profile_name_invalid" });
  }
});
test("rejects an existing profile name as profile_exists", () => {
  const result = fixture(
    String.raw`
(ROOT / 'profiles' / 'sophie').mkdir(parents=True)
subprocess.Popen = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('must not run'))
entry('create-profile',main('discover')['candidates'][0]['id'],${JSON.stringify(JSON.stringify({ name: "sophie" }))})
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, { error: "profile_exists" });
});
test("profile creation calls only the Hermes CLI and re-reads the disk to confirm it was created", () => {
  const result = fixture(
    String.raw`
import io
calls = []
def fake(argv, **kwargs):
    calls.append(argv)
    (ROOT / 'profiles' / 'sophie').mkdir(parents=True)
    return type('Result',(),{'stdout':io.BytesIO(b''), 'wait':lambda self:0})()
subprocess.Popen = fake
created = main('create-profile',main('discover')['candidates'][0]['id'],OPTION)
print(json.dumps({'created':created,'argv':calls[0][1:]}))
`.replace("OPTION", JSON.stringify(JSON.stringify({ name: "sophie", description: "리서치" }))),
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body.created, { ok: true, profile: "sophie" });
  assert.deepEqual(result.body.argv, [
    "-m",
    "hermes_cli.main",
    "profile",
    "create",
    "sophie",
    "--description",
    "리서치",
  ]);
});
test("profile_create_failed when the profile directory is missing even though the command succeeded", () => {
  const result = fixture(
    String.raw`
import io
subprocess.Popen = lambda argv, **kwargs: type('Result',(),{'stdout':io.BytesIO(b''), 'wait':lambda self:0})()
entry('create-profile',main('discover')['candidates'][0]['id'],${JSON.stringify(JSON.stringify({ name: "sophie" }))})
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, { error: "profile_create_failed" });
});
test("a new profile outside the allowlist is a profile_not_served warning, not a failure", () => {
  const result = fixture(
    String.raw`
import io
def fake(argv, **kwargs):
    (ROOT / 'profiles' / 'sophie').mkdir(parents=True)
    return type('Result',(),{'stdout':io.BytesIO(b''), 'wait':lambda self:0})()
subprocess.Popen = fake
print(json.dumps(main('create-profile',main('discover')['candidates'][0]['id'],${JSON.stringify(JSON.stringify({ name: "sophie" }))})))
`,
    {
      config: {
        gateway: { multiplex_profiles: true, multiplex_profile_allowlist: ["default", "oliver"] },
      },
    },
  );
  assert.deepEqual(result.body, { ok: true, profile: "sophie", warning: "profile_not_served" });
  assert.ok(!result.config.includes("sophie"));
});
test("a profile that already has a key is not rotated and succeeds as-is", () => {
  const result = fixture(
    String.raw`
child = ROOT / 'profiles' / 'sophie'
child.mkdir(parents=True)
(child / '.env').write_text('API_SERVER_KEY=sophie-private-valid-key\n')
result = main('provision-key',main('discover')['candidates'][0]['id'],'sophie')
print(json.dumps({'result':result,'env':(child / '.env').read_text()}))
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body.result, { ok: true, provisioned: false, profile: "sophie" });
  assert.equal(result.body.env, "API_SERVER_KEY=sophie-private-valid-key\n");
});
test("issues new keys only to sibling profiles without a key", () => {
  const result = fixture(
    String.raw`
child = ROOT / 'profiles' / 'sophie'
child.mkdir(parents=True)
(child / '.env').write_text('OTHER=keep-me\n')
result = main('provision-key',main('discover')['candidates'][0]['id'],'sophie')
print(json.dumps({'result':result,'length':len(envfile(child)['API_SERVER_KEY']),'env':(child / '.env').read_text()}))
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body.result, { ok: true, provisioned: true, profile: "sophie" });
  assert.equal(result.body.length, 64);
  assert.match(result.body.env, /^OTHER=keep-me\nAPI_SERVER_KEY=[a-f0-9]{64}\n$/);
  // The owner's key is handled by configure — this action doesn't touch it.
  assert.equal(result.env, "");
});
test("does not issue keys to profiles using an external secret provider", () => {
  const result = fixture(
    String.raw`
child = ROOT / 'profiles' / 'sophie'
child.mkdir(parents=True)
(child / 'config.yaml').write_text(json.dumps({'secrets':{'bitwarden':{'enabled':True}}}))
entry('provision-key',main('discover')['candidates'][0]['id'],'sophie')
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, { error: "profile_provision_forbidden" });
});
test("cannot issue sibling profile keys by using a profile folder as the candidate", () => {
  const result = fixture(
    String.raw`
for name in ('sophie','oliver'):
    (ROOT / 'profiles' / name).mkdir(parents=True)
entry('provision-key',hashlib.sha256(str(ROOT / 'profiles' / 'sophie').encode()).hexdigest(),'oliver')
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, { error: "candidate_changed" });
});
test("provision-key also rejects reserved words and invalid names", () => {
  for (const name of ["default", "root", "Sophie", ""]) {
    const result = fixture(
      String.raw`
entry('provision-key',main('discover')['candidates'][0]['id'],${JSON.stringify(name)})
`,
      { config: { gateway: { multiplex_profiles: true } } },
    );
    assert.deepEqual(result.body, { error: "profile_name_invalid" });
  }
});
test("inspection fills canProvision for sibling profiles without a key too", () => {
  const result = fixture(
    String.raw`
for name, token in (('sophie',''),('oliver','oliver-private-valid-key')):
    home = ROOT / 'profiles' / name
    home.mkdir(parents=True)
    if token: (home / '.env').write_text('API_SERVER_KEY=' + token + '\n')
print(json.dumps(main('inspect',main('discover')['candidates'][0]['id'])['profiles']))
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.deepEqual(result.body, [
    { name: "default", hasToken: false, canProvision: true },
    { name: "oliver", hasToken: true },
    { name: "sophie", hasToken: false, canProvision: true },
  ]);
});
test("an empty model list in verification is a model_provider_required warning, not a failure", () => {
  const result = fixture(
    String.raw`
assert_port_owned = lambda public, owner: True
def live(port,token,path):
    if path == '/deskrpg/info': return 200, {'plugin':'deskrpg','version':'0.6.0'}
    if path == '/deskrpg/profiles': return 200, {'profiles':[{'name':'default'}]}
    if path == '/v1/models': return 200, {'data':[]}
    return 404, None
request = live
print(json.dumps(main('verify',main('discover')['candidates'][0]['id'])))
`,
    {
      config: { gateway: { multiplex_profiles: true } },
      env: "API_SERVER_KEY=default-own-valid-token\n",
    },
  );
  assert.deepEqual(result.body.warnings, ["model_provider_required"]);
  assert.deepEqual(result.body.prepared.profiles, [
    { name: "default", token: "default-own-valid-token" },
  ]);
});
test("leaves no warning when there is at least one model", () => {
  const result = fixture(
    String.raw`
assert_port_owned = lambda public, owner: True
def live(port,token,path):
    if path == '/deskrpg/info': return 200, {'plugin':'deskrpg','version':'0.6.0'}
    if path == '/deskrpg/profiles': return 200, {'profiles':[{'name':'default'}]}
    if path == '/v1/models': return 200, {'data':[{'id':'model'}]}
    return 404, None
request = live
print(json.dumps(main('verify',main('discover')['candidates'][0]['id'])))
`,
    {
      config: { gateway: { multiplex_profiles: true } },
      env: "API_SERVER_KEY=default-own-valid-token\n",
    },
  );
  assert.deepEqual(result.body.warnings, []);
});
test("profile creation and key issuance steps run in contract order before plugin work", async () => {
  const f = fake([
    { candidate, pluginStatus: "plugin_absent", changes: ["installing_plugin"] },
    { ok: true, profile: "sophie" },
    { ok: true, provisioned: true, profile: "sophie" },
    { ok: true },
    { ok: true },
    { ok: true },
    {
      prepared: {
        baseUrl: "http://127.0.0.1:8642",
        token: "existing-private-token",
        profiles: [{ name: "sophie", token: "sophie-private-token" }],
      },
      warnings: ["model_provider_required"],
    },
  ]);
  const steps: string[] = [];
  const result = await prepareHost(
    f.execute,
    candidate.id,
    (s) => steps.push(s),
    undefined,
    undefined,
    {
      createProfile: { name: "sophie", description: "리서치" },
    },
  );
  assert.deepEqual(steps, [
    "inspecting",
    "creating_profile",
    "provisioning_keys",
    "installing_plugin",
    "configuring_api",
    "restarting_gateway",
    "verifying_gateway",
  ]);
  assert.deepEqual(
    f.calls.map((c) => JSON.parse(c.input!).action),
    ["inspect", "create-profile", "provision-key", "install", "configure", "restart", "verify"],
  );
  assert.deepEqual(result.warnings, ["model_provider_required"]);
});
test("does not issue a key to a profile created outside the allowlist, only passes on the warning", async () => {
  const f = fake([
    {
      candidate: {
        ...candidate,
        pluginInstalled: true,
        pluginEnabled: true,
        pluginVersion: "0.6.0",
        hasToken: true,
      },
      pluginStatus: "plugin_ready",
      changes: [],
    },
    { ok: true, profile: "sophie", warning: "profile_not_served" },
    {
      prepared: { baseUrl: "http://127.0.0.1:8642", token: "existing-private-token", profiles: [] },
    },
  ]);
  const steps: string[] = [];
  const result = await prepareHost(
    f.execute,
    candidate.id,
    (s) => steps.push(s),
    undefined,
    undefined,
    {
      createProfile: { name: "sophie" },
    },
  );
  assert.deepEqual(steps, ["inspecting", "creating_profile", "verifying_gateway"]);
  assert.deepEqual(result.warnings, ["profile_not_served"]);
});
test("stops with profile_verify_failed when an issued key is not actually served", async () => {
  const f = fake([
    {
      candidate: {
        ...candidate,
        pluginInstalled: true,
        pluginEnabled: true,
        pluginVersion: "0.6.0",
        hasToken: true,
      },
      pluginStatus: "plugin_ready",
      changes: [],
    },
    { ok: true, provisioned: true, profile: "sophie" },
    {
      prepared: { baseUrl: "http://127.0.0.1:8642", token: "existing-private-token", profiles: [] },
    },
  ]);
  await assert.rejects(
    prepareHost(f.execute, candidate.id, () => {}, undefined, undefined, {
      provisionKeys: ["sophie"],
    }),
    /^Error: profile_verify_failed$/,
  );
});
test("the server re-checks name and count before handing off to the host", async () => {
  const f = fake([]);
  for (const provision of [
    { createProfile: { name: "Sophie" } },
    { createProfile: { name: "default" } },
    { createProfile: { name: "sophie", description: "두\n줄" } },
    { provisionKeys: ["root"] },
  ]) {
    await assert.rejects(
      prepareHost(f.execute, candidate.id, () => {}, undefined, undefined, provision),
      /^Error: profile_name_invalid$/,
    );
  }
  await assert.rejects(
    prepareHost(f.execute, candidate.id, () => {}, undefined, undefined, {
      provisionKeys: Array.from({ length: 11 }, (_, i) => `profile${i}`),
    }),
    /^Error: setup_invalid_request$/,
  );
  assert.equal(f.calls.length, 0);
});

// --- Contract 2: local Hermes install ----------------------------------------------------
import { HOST_INSTALLER } from "./host-helper";
/** Runs the install script without a real network or bash. Observations come back only as files under HOME. */
function installer(prelude: string, prepared = false) {
  const temp = mkdtempSync(join(tmpdir(), "deskrpg-install-test-"));
  if (prepared) mkdirSync(join(temp, ".hermes/hermes-agent"), { recursive: true });
  try {
    const result = spawnSync("python3", ["-"], {
      input: prelude + HOST_INSTALLER,
      encoding: "utf8",
      env: { ...process.env, HOME: temp, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = join(temp, "observed.json");
    return {
      body: JSON.parse(result.stdout),
      observed: existsSync(observed) ? JSON.parse(readFileSync(observed, "utf8")) : null,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
const INSTALL_SCRIPT = "#!/usr/bin/env bash\necho installing hermes\n";
const STUBS = String.raw`
import io, json, os, pathlib, subprocess, urllib.request
observed = {'fetched': [], 'argv': None, 'script_exists': False, 'script_body': None, 'probe': None}
def record():
    (pathlib.Path.home() / 'observed.json').write_text(json.dumps(observed))
class FakeResponse:
    def __init__(self, body): self.body = body
    def read(self, size=-1): return self.body
    def __enter__(self): return self
    def __exit__(self, *unused): return False
class FakeOpener:
    def open(self, url, timeout=None):
        observed['fetched'].append(url)
        record()
        if BODY is None: raise OSError('network down')
        return FakeResponse(BODY)
urllib.request.build_opener = lambda *args, **kwargs: FakeOpener()
class FakeChild:
    def __init__(self, output): self.stdout = io.BytesIO(output)
    def kill(self): pass
    def wait(self): return EXIT
def fake_popen(argv, **kwargs):
    observed['argv'] = list(argv)
    observed['script_exists'] = os.path.isfile(argv[1]) if len(argv) > 1 else False
    observed['script_body'] = pathlib.Path(argv[1]).read_text() if observed['script_exists'] else None
    record()
    if EXIT == 0:
        venv = pathlib.Path.home() / '.hermes' / 'hermes-agent' / 'venv' / 'bin'
        venv.mkdir(parents=True)
        (venv / 'python').write_text('')
    return FakeChild(OUTPUT)
subprocess.Popen = fake_popen
def fake_run(argv, **kwargs):
    observed['probe'] = list(argv)[1:]
    record()
    return type('Result',(),{'returncode':PROBE})()
subprocess.run = fake_run
`;
function stubs(
  options: { body?: string | null; exit?: number; probe?: number; output?: string } = {},
) {
  return STUBS.replace("BODY is None", options.body === null ? "True" : "False")
    .replace(
      /\bBODY\b/,
      options.body === null ? "None" : JSON.stringify(options.body ?? INSTALL_SCRIPT) + ".encode()",
    )
    .replace(/\bEXIT\b/g, String(options.exit ?? 0))
    .replace(/\bOUTPUT\b/g, JSON.stringify(options.output ?? "installing\n") + ".encode()")
    .replace(/\bPROBE\b/g, String(options.probe ?? 0));
}
test("the install script runs as a file, not a pipe, and its fingerprint lands in the result", () => {
  const result = installer(stubs());
  assert.equal(result.body.ok, true);
  assert.match(result.body.installerDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    result.body.installerDigest,
    createHash("sha256").update(INSTALL_SCRIPT).digest("hex"),
  );
  assert.deepEqual(result.observed.fetched, ["https://hermes-agent.nousresearch.com/install.sh"]);
  assert.equal(result.observed.argv[0], "bash");
  assert.ok(result.observed.argv[1].endsWith(".sh"));
  assert.deepEqual(result.observed.argv.slice(2), ["--skip-browser", "--skip-setup"]);
  // Runs a real file, not a pipe (`curl | bash`).
  assert.equal(result.observed.script_exists, true);
  assert.equal(result.observed.script_body, INSTALL_SCRIPT);
  assert.deepEqual(result.observed.probe, ["-m", "hermes_cli.main", "--version"]);
});
test("neither downloads nor runs anything when already installed", () => {
  const result = installer(stubs(), true);
  assert.deepEqual(result.body, { error: "hermes_already_installed" });
  assert.equal(result.observed, null);
});
test("hermes_installer_unavailable when the install script can't be downloaded", () => {
  const result = installer(stubs({ body: null }));
  assert.deepEqual(result.body, { error: "hermes_installer_unavailable" });
  assert.equal(result.observed.argv, null);
});
test("install failure is reported only with a fixed code and returns no output", () => {
  const result = installer(stubs({ exit: 3, output: "token=super-secret\n" }));
  assert.deepEqual(result.body, { error: "hermes_install_failed" });
  assert.ok(!JSON.stringify(result.body).includes("super-secret"));
});
test("classifies a network drop during install as installer_unavailable", () => {
  const result = installer(stubs({ exit: 1, output: "curl: (6) Could not resolve host: x\n" }));
  assert.deepEqual(result.body, { error: "hermes_installer_unavailable" });
});
test("hermes_install_failed when the CLI doesn't exit 0 after install", () => {
  const result = installer(stubs({ probe: 2 }));
  assert.deepEqual(result.body, { error: "hermes_install_failed" });
});
test("large output from a normal install is read and discarded without hitting the cap", () => {
  const result = installer(stubs({ output: "x".repeat(600_000) }));
  assert.equal(result.body.ok, true);
});
test("leaves no temporary script behind once install finishes", () => {
  const temp = mkdtempSync(join(tmpdir(), "deskrpg-install-residue-"));
  try {
    const result = spawnSync("python3", ["-"], {
      input: stubs() + HOST_INSTALLER,
      encoding: "utf8",
      env: { ...process.env, HOME: temp, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    const residue = readdirSync(join(temp, ".hermes")).filter((name) => name.endsWith(".sh"));
    assert.deepEqual(residue, []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("the install lock prevents concurrent installs", () => {
  const result = installer(
    String.raw`
import fcntl, os, pathlib
root = pathlib.Path.home() / '.hermes'
root.mkdir(parents=True, exist_ok=True)
held = open(root / '.deskrpg-setup.lock','w')
fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
` + stubs(),
  );
  assert.deepEqual(result.body, { error: "host_busy" });
});
test("the install result fingerprint passes only as 64 lowercase hex characters", async () => {
  const digest = "b".repeat(64);
  const good = await installHermesHost(fake([{ ok: true, installerDigest: digest }]).execute);
  assert.deepEqual(good, { installerDigest: digest, milestones: [] });
  for (const bad of [{ ok: true }, { ok: true, installerDigest: "NOT-HEX" }])
    await assert.rejects(
      installHermesHost(fake([bad]).execute),
      /^Error: (hermes_install_failed|host_operation_failed)$/,
    );
});
test("install error codes outside the whitelist don't leak the original text", async () => {
  await assert.rejects(
    installHermesHost(fake([{ error: "hermes_already_installed" }]).execute),
    /^Error: hermes_already_installed$/,
  );
  await assert.rejects(
    installHermesHost(fake([{ error: "token=secret leaked" }]).execute),
    /^Error: host_operation_failed$/,
  );
});

// On Linux the service name ('hermes-gateway.service') is filled in first even without a unit file.
// Back when this was decided by name, the registration step was dropped entirely on fresh installs (observed: new
// account on MiniPC).
const UNIT_MISSING_LINUX = String.raw`
state = {'installed': False}
def linux_identity(name,home):
    result = fixture_identity(name,home)
    if not state['installed']:
        result['command'] = None
        result['warning'] = 'managed_service_required'
    return result
identity = linux_identity
`;
test("installing_service goes into the plan when there is no unit even if the service name is filled", () => {
  const result = fixture(
    UNIT_MISSING_LINUX +
      String.raw`
id = main('discover')['candidates'][0]['id']
print(json.dumps(main('inspect', id)))
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.ok(result.body.changes.includes("installing_service"));
});
test("no registration step when the unit is already healthy", () => {
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
print(json.dumps(main('inspect', id)))
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.ok(!result.body.changes.includes("installing_service"));
});
test("someone else's unit (identity_mismatch) is not treated as a registration target", () => {
  // A modified unit or someone else's unit must not be overwritten by gateway install.
  const result = fixture(
    String.raw`
def mismatched(name,home):
    result = fixture_identity(name,home)
    result['command'] = None
    result['warning'] = 'service_identity_mismatch'
    return result
identity = mismatched
id = main('discover')['candidates'][0]['id']
print(json.dumps(main('inspect', id)))
`,
    { config: { gateway: { multiplex_profiles: true } } },
  );
  assert.ok(!result.body.changes.includes("installing_service"));
});
test("configure doesn't die even on a config whose gateway value is empty", () => {
  // A freshly installed Hermes config.yaml has the `gateway:` key with no value (observed).
  const result = fixture(
    String.raw`
id = main('discover')['candidates'][0]['id']
print(json.dumps(main('configure', id)))
`,
    { config: { gateway: null } },
  );
  assert.deepEqual(result.body, { ok: true });
});

const AUTH_STUB = String.raw`
original_run = run
def run(argv, timeout=8, env=None):
    if 'auth' not in argv: return original_run(argv, timeout=timeout, env=env)
    OUTCOME
`;
/** Stub that intercepts only `hermes auth status <provider>`. Other calls take the original path as-is. */
function authStub(outcome: string) {
  return AUTH_STUB.replace("OUTCOME", outcome);
}
const CHECK_MODEL = String.raw`
id = main('discover')['candidates'][0]['id']
print(json.dumps(main('check-model', id)))
`;
test("the check result is unknown when the model provider is not in the config", () => {
  // No basis to decide means no decision. The command isn't even called.
  const result = fixture(authStub("raise AssertionError('must not run')") + CHECK_MODEL, {
    config: { gateway: {} },
  });
  assert.deepEqual(result.body, { ok: true, model: "unknown" });
});
test("ready when the output contains logged in and the exit code is 0", () => {
  // The observed output is one line: 'openai-codex: logged in'.
  const result = fixture(
    authStub(
      "return type('R',(),{'returncode':0,'stdout':'openai-codex: logged in','stderr':''})()",
    ) + CHECK_MODEL,
    { config: { model: { provider: "openai-codex" } } },
  );
  assert.deepEqual(result.body, { ok: true, model: "ready" });
});
test("any other output is missing", () => {
  const result = fixture(
    authStub(
      "return type('R',(),{'returncode':1,'stdout':'openai-codex: not logged in','stderr':''})()",
    ) + CHECK_MODEL,
    { config: { provider: "openai-codex" } },
  );
  assert.deepEqual(result.body, { ok: true, model: "missing" });
});
test("a crashing check command doesn't fail setup and returns unknown", () => {
  const result = fixture(authStub("raise OSError('boom')") + CHECK_MODEL, {
    config: { model: { provider: "openai-codex" } },
  });
  assert.deepEqual(result.body, { ok: true, model: "unknown" });
});
test("the check result carries no raw command output", () => {
  const result = fixture(
    authStub(
      "return type('R',(),{'returncode':0,'stdout':'openai-codex: logged in as sk-secret-token','stderr':''})()",
    ) + CHECK_MODEL,
    { config: { model: { provider: "openai-codex" } } },
  );
  assert.deepEqual(result.body, { ok: true, model: "ready" });
  assert.ok(!JSON.stringify(result.body).includes("sk-secret-token"));
});
test("the model check doesn't throw even when the host can't decide", async () => {
  assert.equal(
    await checkModelHost(fake([{ ok: true, model: "ready" }]).execute, candidate.id),
    "ready",
  );
  assert.equal(
    await checkModelHost(fake([{ ok: true, model: "missing" }]).execute, candidate.id),
    "missing",
  );
  for (const reply of [
    { error: "hermes_not_found" },
    { ok: true, model: "logged in" },
    { ok: true },
  ])
    assert.equal(await checkModelHost(fake([reply]).execute, candidate.id), "unknown");
  // Even a mismatched candidate id is not an error but undecidable — it can't stop setup.
  assert.equal(await checkModelHost(fake([]).execute, "../profile"), "unknown");
});
test("install milestones come up only as defined codes, in order", async () => {
  const digest = "c".repeat(64);
  const result = await installHermesHost(
    fake([
      {
        ok: true,
        installerDigest: digest,
        milestones: ["deps", "deps", "venv", "rm -rf /home/dante", "done"],
      },
    ]).execute,
  );
  // Values outside the list are dropped — line content can't pose as a code and land on the job.
  assert.deepEqual(result, { installerDigest: digest, milestones: ["deps", "venv", "done"] });
});
test("install output lines fold only into milestone codes and the original text is not in the result", () => {
  const output = [
    "Installing dependencies...",
    "Creating virtual environment with Python 3.11...",
    "Running npm install for the dashboard",
    "Syncing bundled skills to ~/.hermes/skills/ ...",
    "TOKEN=sk-do-not-leak",
    "Installation Complete!",
  ].join("\n");
  const result = installer(stubs({ output }));
  assert.deepEqual(result.body.milestones, ["deps", "venv", "node_modules", "skills", "done"]);
  assert.ok(!JSON.stringify(result.body).includes("sk-do-not-leak"));
  assert.ok(!JSON.stringify(result.body).includes("Installing dependencies"));
});
test("all six milestones are hit by the sentences the real install script prints", () => {
  // The sentences were taken from install.sh's log_info originals. The first table treated 'clone' as literal, but
  // git prints "Cloning into ...", so that milestone was never hit (observed).
  const output = [
    "Installing managed uv into /home/x/.hermes/bin ...",
    "Cloning into '/home/x/.hermes/hermes-agent'...",
    "Creating virtual environment with Python 3.11...",
    "Installing Node.js dependencies (browser tools)...",
    "Syncing bundled skills to ~/.hermes/skills/ ...",
    "✓ Installation Complete!",
  ].join("\n");
  const result = installer(stubs({ output }));
  assert.deepEqual(result.body.milestones, [
    "deps",
    "clone",
    "venv",
    "node_modules",
    "skills",
    "done",
  ]);
});
test("resume skips finished steps and verify always runs again", async () => {
  const f = fake([
    {
      candidate: { ...candidate, pluginInstalled: true, pluginEnabled: true },
      pluginStatus: "plugin_ready",
      changes: [],
    },
    { ok: true, provisioned: false },
    {
      prepared: {
        baseUrl: "http://127.0.0.1:8642",
        token: "existing-private-token",
        profiles: [
          { name: "default", token: "existing-private-token" },
          { name: "oliver", token: "oliver-private-token" },
        ],
      },
    },
  ]);
  const steps: string[] = [];
  const completed = new Set(["inspecting", "creating_profile", "verifying_gateway"]);
  const result = await prepareHost(
    f.execute,
    candidate.id,
    (s) => steps.push(s),
    undefined,
    undefined,
    { createProfile: { name: "oliver" } },
    (step) => completed.has(step) && step !== "inspecting" && step !== "verifying_gateway",
  );
  // Don't recreate an already-created profile (recreating is profile_exists). Key issuance still runs.
  assert.deepEqual(steps, ["inspecting", "provisioning_keys", "verifying_gateway"]);
  assert.ok(
    !f.calls.some((call) => JSON.parse(String(call.input)).action === "create-profile"),
    "이미 만든 프로필을 다시 만들면 안 된다",
  );
  assert.equal(result.profiles.length, 2);
});
test("every step runs as-is when no skip is given", async () => {
  const f = fake([
    {
      candidate,
      pluginStatus: "plugin_absent",
      changes: ["installing_service", "installing_plugin"],
    },
    { ok: true, candidateId: "d".repeat(64) },
    { ok: true },
    { ok: true },
    { ok: true },
    {
      prepared: {
        baseUrl: "http://127.0.0.1:8642",
        token: "existing-private-token",
        profiles: [{ name: "default", token: "existing-private-token" }],
      },
    },
  ]);
  const steps: string[] = [];
  await prepareHost(f.execute, candidate.id, (s) => steps.push(s));
  assert.deepEqual(steps, [
    "inspecting",
    "installing_service",
    "installing_plugin",
    "configuring_api",
    "restarting_gateway",
    "verifying_gateway",
  ]);
});

test("an alternative port is attached to the error on a port conflict when available", async () => {
  const f = fake([{ error: "port_conflict", suggestedPort: 8643 }]);
  await assert.rejects(inspectHost(f.execute, candidate.id), (error: unknown) => {
    assert.ok(error instanceof SetupPortConflictError);
    assert.equal((error as Error).message, "port_conflict");
    assert.equal((error as SetupPortConflictError).suggestedPort, 8643);
    return true;
  });
});
test("drops port suggestions outside the suggestion range or that aren't numbers", async () => {
  for (const suggestedPort of [8641, 8700, 0, "8643", 8643.5, null]) {
    const f = fake([{ error: "port_conflict", suggestedPort }]);
    await assert.rejects(inspectHost(f.execute, candidate.id), (error: unknown) => {
      assert.ok(error instanceof SetupPortConflictError);
      assert.equal((error as SetupPortConflictError).suggestedPort, undefined);
      return true;
    });
  }
});
test("without a suggestion a port conflict leaves only the code as it does now", async () => {
  const f = fake([{ error: "port_conflict" }]);
  await assert.rejects(inspectHost(f.execute, candidate.id), (error: unknown) => {
    assert.ok(error instanceof SetupPortConflictError);
    assert.equal((error as SetupPortConflictError).suggestedPort, undefined);
    return true;
  });
});
/** A candidate whose plugin is already ready — leaves only the port step so the step order is clear. */
const readyCandidate: SetupCandidate = {
  ...candidate,
  pluginInstalled: true,
  pluginEnabled: true,
  pluginVersion: "0.6.0",
};
test("an accepted port is written once via set-port right before inspect", async () => {
  const f = fake([
    { ok: true, port: 8643 },
    { candidate: readyCandidate, pluginStatus: "plugin_ready", changes: [] },
    {
      prepared: {
        baseUrl: "http://127.0.0.1:8642",
        token: "existing-private-token",
        profiles: [{ name: "default", token: "existing-private-token" }],
      },
    },
  ]);
  const steps: string[] = [];
  await prepareHost(
    f.execute,
    candidate.id,
    (s) => steps.push(s),
    undefined,
    undefined,
    undefined,
    undefined,
    8643,
  );
  assert.deepEqual(steps, ["setting_port", "inspecting", "verifying_gateway"]);
  const sent = JSON.parse(String(f.calls[0].input)).script as string;
  assert.match(sent, /entry\("set-port", "[a-f0-9]{64}", "8643"\)/);
});
test("set-port is not called without consent", async () => {
  const f = fake([
    { candidate: readyCandidate, pluginStatus: "plugin_ready", changes: [] },
    {
      prepared: {
        baseUrl: "http://127.0.0.1:8642",
        token: "existing-private-token",
        profiles: [{ name: "default", token: "existing-private-token" }],
      },
    },
  ]);
  const steps: string[] = [];
  await prepareHost(f.execute, candidate.id, (s) => steps.push(s));
  assert.deepEqual(steps, ["inspecting", "verifying_gateway"]);
  // The host script body always contains the 'set-port' string — look only at the actual call, entry().
  assert.ok(
    f.calls.every((call) => !/entry\("set-port"/.test(JSON.parse(String(call.input)).script)),
  );
});
test("set-port rejects out-of-range values before sending them to the host", async () => {
  for (const port of [1023, 65536, 0]) {
    const f = fake([]);
    await assert.rejects(
      prepareHost(
        f.execute,
        candidate.id,
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        port,
      ),
      /setup_invalid_request/,
    );
    assert.equal(f.calls.length, 0);
  }
});
test("a port write failure goes out as port_write_failed and later steps don't run", async () => {
  const f = fake([{ error: "port_write_failed", detail: "/home/op/.env" }]);
  await assert.rejects(
    prepareHost(
      f.execute,
      candidate.id,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      8643,
    ),
    /^Error: port_write_failed$/,
  );
  assert.equal(f.calls.length, 1);
});

test("Linger check — reads yes/no, unknown if it can't tell, and never throws", async () => {
  const { checkLingerHost } = await import("./host");
  const exec = (linger: string, code = 0) =>
    (async (command: string) =>
      command === "id"
        ? { stdout: "dante\n", stderr: "", code: 0 }
        : { stdout: `${linger}\n`, stderr: "", code }) as never;
  assert.equal(await checkLingerHost(exec("yes")), "enabled");
  assert.equal(await checkLingerHost(exec("no")), "disabled");
  assert.equal(await checkLingerHost(exec("", 1)), "unknown");
  assert.equal(
    await checkLingerHost((async () => {
      throw new Error("boom");
    }) as never),
    "unknown",
  );
});

test("SSH key rejection surfaces as ssh_auth_failed in discovery too — not flattened into host_operation_failed", async () => {
  const { discoverHost } = await import("./host");
  await assert.rejects(
    discoverHost(async () => {
      throw new Error("ssh_auth_failed");
    }),
    /^Error: ssh_auth_failed$/,
  );
});

test("POSIX launches the launcher with sh -c", () => {
  const launch = hostLaunch("linux", "run", "CODE", '{"candidates": []}');
  assert.equal(launch.command, "sh");
  assert.deepEqual(launch.args, [
    "-c",
    HOST_LAUNCHER,
    "deskrpg",
    "run",
    "CODE",
    '{"candidates": []}',
  ]);
});

test("win32 launches the launcher with powershell — the payload goes via env, not argv", () => {
  const launch = hostLaunch("win32", "install", "CODE", "NONE");
  assert.equal(launch.command, "powershell");
  assert.deepEqual(launch.args, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    HOST_LAUNCHER_PS,
  ]);
  // Regression guard: `powershell -Command <text> a b c` does not bind a, b, c to $args
  // (observed on WinServer, 2026-09-20) — appending mode/code/none back after argv breaks this assertion.
  assert.deepEqual(launch.env, {
    DESKRPG_HOST_MODE: "install",
    DESKRPG_HOST_CODE: "CODE",
    DESKRPG_HOST_NONE: "NONE",
  });
});

test("the win32 launcher body reads environment variables, not $args", () => {
  // -Command doesn't populate $args, so reverting these three back to $args[...] makes it die silently.
  assert.ok(!/\$args\[/.test(HOST_LAUNCHER_PS));
  assert.ok(HOST_LAUNCHER_PS.includes("$env:DESKRPG_HOST_MODE"));
  assert.ok(HOST_LAUNCHER_PS.includes("$env:DESKRPG_HOST_CODE"));
  assert.ok(HOST_LAUNCHER_PS.includes("$env:DESKRPG_HOST_NONE"));
});

test("the win32 launcher clears the payload variables from its own environment after reading — not passed to the child python", () => {
  assert.ok(HOST_LAUNCHER_PS.includes("Remove-Item Env:\\DESKRPG_HOST_MODE"));
  assert.ok(HOST_LAUNCHER_PS.includes("Remove-Item Env:\\DESKRPG_HOST_CODE"));
  assert.ok(HOST_LAUNCHER_PS.includes("Remove-Item Env:\\DESKRPG_HOST_NONE"));
});

test("the win32 launcher body looks for Scripts\\python.exe", () => {
  assert.ok(HOST_LAUNCHER_PS.includes("Scripts\\python.exe"));
  assert.ok(!HOST_LAUNCHER_PS.includes("bin/python"));
});

test("the win32 launcher does no system package pre-check", () => {
  assert.ok(!HOST_LAUNCHER_PS.includes("system_packages_missing"));
});

test("invoke and installHermesHost pass launch.env to execute() as-is", async () => {
  let seenOptions: { env?: Record<string, string> } | undefined;
  const execute: HostExecutor = async (_command, _args, options) => {
    seenOptions = options;
    return { code: 0, stdout: JSON.stringify({ candidates: [] }), stderr: "" };
  };
  await discoverHost(execute, "win32");
  assert.deepEqual(seenOptions?.env, {
    DESKRPG_HOST_MODE: "run",
    DESKRPG_HOST_CODE: HOST_BOOTSTRAP,
    DESKRPG_HOST_NONE: '{"candidates": []}',
  });
  // POSIX still uses no env at all, as now — passes only via argv.
  await discoverHost(execute, "linux");
  assert.equal(seenOptions?.env, undefined);
});

test("installHermesHost also passes launch.env to execute() on win32", async () => {
  let seenOptions: { env?: Record<string, string> } | undefined;
  const execute: HostExecutor = async (_command, _args, options) => {
    seenOptions = options;
    return {
      code: 0,
      stdout: JSON.stringify({ ok: true, installerDigest: "a".repeat(64) }),
      stderr: "",
    };
  };
  await installHermesHost(execute, undefined, "win32");
  assert.deepEqual(seenOptions?.env, {
    DESKRPG_HOST_MODE: "install",
    DESKRPG_HOST_CODE: HOST_INSTALLER,
    DESKRPG_HOST_NONE: "",
  });
});

test("HOST_BOOTSTRAP branches on win32 in one place", () => {
  assert.equal((HOST_BOOTSTRAP.match(/sys\.platform == 'win32'/g) ?? []).length, 1);
});

test("HOST_BOOTSTRAP does not register SIGHUP unconditionally", () => {
  assert.ok(!/signal\.SIGHUP, signal\.SIGTERM/.test(HOST_BOOTSTRAP));
  assert.ok(HOST_BOOTSTRAP.includes("taskkill"));
  assert.ok(HOST_BOOTSTRAP.includes("CREATE_NEW_PROCESS_GROUP"));
});

test("HOST_INSTALLER knows both install script URLs", () => {
  assert.ok(HOST_INSTALLER.includes("https://hermes-agent.nousresearch.com/install.sh"));
  assert.ok(HOST_INSTALLER.includes("https://hermes-agent.nousresearch.com/install.ps1"));
});

test("HOST_INSTALLER does not import fcntl unconditionally", () => {
  assert.ok(!/^\s*import fcntl\s*$/m.test(HOST_INSTALLER));
  assert.ok(HOST_INSTALLER.includes("msvcrt"));
});

test("HOST_INSTALLER does not use pass_fds on win32", () => {
  assert.ok(HOST_INSTALLER.includes("pass_fds"));
  assert.ok(/if WINDOWS/.test(HOST_INSTALLER));
});

test("HOST_HELPER has a Windows service branch", () => {
  assert.ok(HOST_HELPER.includes("Hermes_Gateway"));
  assert.ok(HOST_HELPER.includes("schtasks"));
  assert.ok(HOST_HELPER.includes("gateway-service"));
});

test("the Windows branch uses only the same ownership warning codes", () => {
  const codes = HOST_HELPER.match(/'(service_identity_\w+|managed_service_required)'/g) ?? [];
  assert.ok(codes.length > 0);
  for (const code of new Set(codes))
    assert.ok(
      [
        "'service_identity_mismatch'",
        "'service_identity_ambiguous'",
        "'managed_service_required'",
      ].includes(code),
      `${code} 는 허용되지 않은 코드다`,
    );
});

test("HOST_BOOTSTRAP contains only ASCII — it is the only host script passed as a command-line argument", () => {
  // Other host scripts (HELPER, INSTALLER) go as a JSON payload on stdin, but the bootstrap alone
  // goes as the **argv** of `python3 -c <code>`. Python decodes argv with the locale encoding, so
  // even a single Korean comment line makes it, on a host with a C/POSIX locale + UTF-8 mode off,
  // **fail to even start** with "Unable to decode the command from the command line".
  // macOS always reads argv as UTF-8, so it doesn't show up locally — Linux CI caught it (2026-09-20).
  const offenders = HOST_BOOTSTRAP.split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /[^\x00-\x7f]/.test(line));
  assert.deepEqual(
    offenders.map(({ number, line }) => `${number}: ${line.trim()}`),
    [],
    "부트스트랩의 주석·문자열은 영문으로 쓴다",
  );
});

test("HOST_BOOTSTRAP round-trips a Korean payload even under a non-UTF-8 locale", () => {
  // Reproduces Windows' default pipe encoding (e.g. cp949) on POSIX: PYTHONUTF8=0 + LC_ALL/LANG=C
  // forces python's default stdin/stdout encoding to ascii (turns off the UTF-8 mode of PEP 538/540).
  //
  // The bootstrap runs scripts with the python in `~/.hermes/hermes-agent/venv`. Relying on the developer machine's
  // real Hermes would fall to `hermes_not_found` in CI without Hermes, so a venv with only the stdlib is set up
  // in a temporary HOME to create the same conditions wherever it runs.
  const temp = mkdtempSync(join(tmpdir(), "deskrpg-bootstrap-locale-test-"));
  try {
    const venv = spawnSync(
      "python3",
      ["-m", "venv", "--without-pip", join(temp, ".hermes/hermes-agent/venv")],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(venv.status, 0, venv.stderr);
    const script = String.raw`print(__import__('json').dumps({'echo': '한글 확인 문자열'}))`;
    const result = spawnSync("python3", ["-c", HOST_BOOTSTRAP], {
      encoding: "utf8",
      // The script returns at once, so a wide budget costs nothing and a loaded machine can't trip it.
      input: JSON.stringify({ action: "run", timeout: 20, script }),
      env: { ...process.env, HOME: temp, PYTHONUTF8: "0", LC_ALL: "C", LANG: "C" },
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { echo: "한글 확인 문자열" });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("restarts the gateway even when only the plugin was updated — new code is served only after a restart", async () => {
  // The host already puts `restarting_gateway` into changes (the inspect test above). But
  // prepareHost only restarted when configure/timezone ran, so in the common case where only the plugin lagged
  // the old code kept being served (the Hermes CLI also says "Restart the gateway" after install).
  const stale = {
    ...candidate,
    pluginInstalled: true,
    pluginEnabled: true,
    pluginVersion: "0.5.0",
    hasToken: true,
  };
  const f = fake([
    {
      candidate: stale,
      pluginStatus: "plugin_ready",
      changes: ["updating_plugin", "restarting_gateway"],
    },
    { ok: true },
    { ok: true },
    {
      prepared: { baseUrl: "http://127.0.0.1:8642", token: "existing-private-token", profiles: [] },
    },
  ]);
  const steps: string[] = [];
  await prepareHost(f.execute, candidate.id, (s) => steps.push(s));
  assert.deepEqual(steps, [
    "inspecting",
    "updating_plugin",
    "restarting_gateway",
    "verifying_gateway",
  ]);
  assert.deepEqual(
    f.calls.map((c) => JSON.parse(c.input!).action),
    ["inspect", "install", "restart", "verify"],
  );
});

test("restarts only once even when several restart conditions are true", async () => {
  // On the first-install path, configure and the host's restarting_gateway are both true.
  const stale = {
    ...candidate,
    pluginInstalled: true,
    pluginEnabled: true,
    pluginVersion: "0.5.0",
    hasToken: true,
  };
  const f = fake([
    {
      candidate: stale,
      pluginStatus: "plugin_ready",
      changes: ["updating_plugin", "configuring_api", "restarting_gateway"],
    },
    { ok: true },
    { ok: true },
    { ok: true },
    {
      prepared: { baseUrl: "http://127.0.0.1:8642", token: "existing-private-token", profiles: [] },
    },
  ]);
  const steps: string[] = [];
  await prepareHost(f.execute, candidate.id, (s) => steps.push(s));
  assert.equal(steps.filter((s) => s === "restarting_gateway").length, 1);
  assert.equal(
    f.calls.map((c) => JSON.parse(c.input!).action).filter((a) => a === "restart").length,
    1,
  );
});
