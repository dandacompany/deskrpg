const assert = require("node:assert/strict");
const test = require("node:test");

const { buildDaemonCommandLine, buildWmiLaunchScript } = require("./windows-daemon.js");

// `deskrpg start -d` on Windows: a detached child still lives in the parent's job object, and
// Windows OpenSSH (and a closing console) ends the whole job with the session. A process created
// through WMI (Win32_Process.Create) is started by the WMI service instead, outside that job.

const input = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  cliPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\deskrpg\\bin\\deskrpg.js",
  logFile: "C:\\Users\\me\\.deskrpg\\logs\\deskrpg.log",
  env: { DESKRPG_HOME: "C:\\Users\\me\\.deskrpg", PORT: "38200" },
};

test("the daemon runs the CLI's foreground start under cmd, with its environment and log redirect", () => {
  assert.equal(
    buildDaemonCommandLine(input),
    'cmd.exe /d /s /c "set "DESKRPG_HOME=C:\\Users\\me\\.deskrpg"&& set "PORT=38200"&& ' +
      '"C:\\Program Files\\nodejs\\node.exe" ' +
      '"C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\deskrpg\\bin\\deskrpg.js" start ' +
      '>> "C:\\Users\\me\\.deskrpg\\logs\\deskrpg.log" 2>&1"',
  );
});

test("start arguments such as the port follow the start command", () => {
  assert.match(
    buildDaemonCommandLine({ ...input, env: {}, args: ["-p", "38200"] }),
    /deskrpg\.js" start -p 38200 >> /,
  );
});

test("values cmd would interpret are refused rather than escaped", () => {
  for (const bad of [
    'C:\\a"b',
    "C:\\a&b",
    "C:\\a|b",
    "C:\\a%PATH%",
    "C:\\a^b",
    "C:\\a<b",
    "C:\\a>b",
  ]) {
    assert.throws(
      () => buildDaemonCommandLine({ ...input, env: { DESKRPG_HOME: bad } }),
      /unsafe_path/,
      bad,
    );
  }
  assert.throws(
    () => buildDaemonCommandLine({ ...input, env: { "BAD NAME": "x" } }),
    /unsafe_path/,
  );
});

test("the WMI script passes the command line as a single-quoted PowerShell string", () => {
  const script = buildWmiLaunchScript('cmd.exe /c "it\'s"', "C:\\srv");
  assert.match(script, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(script, /CommandLine = 'cmd\.exe \/c "it''s"'/);
  assert.match(script, /CurrentDirectory = 'C:\\srv'/);
});
