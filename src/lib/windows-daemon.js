/**
 * `deskrpg start -d` on Windows. A `detached` child still belongs to the parent's job object,
 * and Windows OpenSSH — like a console window being closed — ends every process in that job
 * when the session ends, so the server died silently with its launching shell. A process
 * created through WMI (`Win32_Process.Create`) is started by the WMI service, outside that job,
 * and keeps running. It runs the CLI's own foreground `start`, which writes the PID file and
 * forwards `deskrpg stop` to the server as usual.
 */

// Characters cmd.exe would act on inside the command line. Paths with them are refused, not escaped.
const CMD_SPECIAL = /["&|<>^%!\r\n]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function safe(value) {
  const text = String(value);
  if (!text || CMD_SPECIAL.test(text)) throw new Error("unsafe_path");
  return text;
}

/** The cmd.exe line the WMI-created process runs. */
function buildDaemonCommandLine({ nodePath, cliPath, logFile, env, args = [] }) {
  const sets = Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([name, value]) => {
      if (!ENV_NAME.test(name)) throw new Error("unsafe_path");
      return `set "${name}=${safe(value)}"&& `;
    })
    .join("");
  const extra = args.map((arg) => ` ${safe(arg)}`).join("");
  const inner = `${sets}"${safe(nodePath)}" "${safe(cliPath)}" start${extra} >> "${safe(logFile)}" 2>&1`;
  // /s: cmd strips exactly the outer pair of quotes and runs the rest verbatim.
  return `cmd.exe /d /s /c "${inner}"`;
}

function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/** PowerShell that creates the process through WMI and prints `<returnValue> <processId>`. */
function buildWmiLaunchScript(commandLine, cwd) {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)}; CurrentDirectory = ${psQuote(cwd)} }`,
    '[Console]::Out.Write("$($r.ReturnValue) $($r.ProcessId)")',
  ].join("; ");
}

/**
 * Launches the daemon and returns the WMI-created process id. Throws `daemon_launch_failed`
 * when WMI refuses; the caller then waits for the PID file the foreground start writes.
 */
function launchWindowsDaemon({ nodePath, cliPath, logFile, env, args, cwd }, spawnSync) {
  const script = buildWmiLaunchScript(
    buildDaemonCommandLine({ nodePath, cliPath, logFile, env, args }),
    cwd,
  );
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  const [code, pid] = String(result.stdout || "")
    .trim()
    .split(/\s+/);
  if (result.status !== 0 || code !== "0" || !/^\d+$/.test(pid || "")) {
    throw new Error("daemon_launch_failed");
  }
  return Number(pid);
}

module.exports = { buildDaemonCommandLine, buildWmiLaunchScript, launchWindowsDaemon };
