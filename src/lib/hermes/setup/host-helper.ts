import { isWindows } from "./platform";

/** Kept in a TS constant so Next standalone output includes the helper. No filesystem asset lookup. */
/**
 * The Python that runs first on the host. **ASCII only** — this string alone is passed not via stdin but as
 * argv of `python3 -c <code>`, and Python decodes argv with the locale encoding.
 * A single Korean comment line keeps it from even starting on a C/POSIX-locale host (`host.test.ts` guards this).
 * Put longer explanations in this TS comment; comments inside the Python stay short, English and ASCII.
 */
export const HOST_BOOTSTRAP = String.raw`
import hashlib, json, os, pathlib, re, secrets, shutil, signal, subprocess, sys, tempfile, time
WINDOWS = sys.platform == 'win32'
child = None
# A reply too big for the client's transport is spilled to a private directory and fetched with scp.
SPILL_PREFIX = 'deskrpg-spill-'
SPILL_NAME = re.compile(r'^[0-9a-f]{32}$')
# Windows: a protected DACL with one rule for the current user's SID, then read back by SID.
SET_ACL = '; '.join([
    '$ErrorActionPreference = \x27Stop\x27',
    '$item = Get-Item -LiteralPath $env:DESKRPG_ACL_DIR',
    '$acl = New-Object System.Security.AccessControl.DirectorySecurity',
    '$acl.SetAccessRuleProtection($true, $false)',
    '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, \x27FullControl\x27, \x27ContainerInherit,ObjectInherit\x27, \x27None\x27, \x27Allow\x27)',
    '$acl.AddAccessRule($rule)',
    '$item.SetAccessControl($acl)'])
CHECK_ACL = '; '.join([
    '$ErrorActionPreference = \x27Stop\x27',
    '$acl = Get-Acl -LiteralPath $env:DESKRPG_ACL_DIR',
    '$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$rules = @($acl.Access)',
    '$sid = if ($rules.Count -eq 1) { $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } else { \x27\x27 }',
    'if ($acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and -not $rules[0].IsInherited -and $rules[0].AccessControlType -eq \x27Allow\x27 -and $sid -eq $me) { \x27owner-only\x27 } else { \x27open\x27 }'])
# scp before OpenSSH 9.0 hands the remote path to a shell, so only plain characters are spilled to.
SAFE_PATH = re.compile(r'^[A-Za-z0-9_./:\\-]+$')
def powershell(script, path):
    try:
        return subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], capture_output=True, text=True,
                              errors='replace', timeout=60, env=dict(os.environ, DESKRPG_ACL_DIR=path)).stdout.strip()
    except Exception: return ''
def owner_only(path):
    if WINDOWS: return powershell(CHECK_ACL, path) == 'owner-only'
    st = os.stat(path)
    return st.st_uid == os.getuid() and (st.st_mode & 0o077) == 0
def harden(path):
    # POSIX: mkdtemp already made it 0700; confirm. Windows: set the DACL, then confirm by SID.
    if WINDOWS: powershell(SET_ACL, path)
    return owner_only(path)
def spill_dir(file):
    # The spill directory for a file path, only if it is one: <tempdir>/deskrpg-spill-*/<32 hex>.
    p = pathlib.Path(file)
    if not p.is_absolute() or not SPILL_NAME.match(p.name) or not p.parent.name.startswith(SPILL_PREFIX): return None
    if os.path.realpath(str(p.parent.parent)) != os.path.realpath(tempfile.gettempdir()): return None
    if os.path.islink(str(p.parent)) or not os.path.isdir(str(p.parent)): return None
    if not WINDOWS and os.stat(str(p.parent)).st_uid != os.getuid(): return None
    return str(p.parent)
def sweep():
    # Spills an earlier client never cleaned up (it died mid-fetch) go after 15 minutes.
    base = tempfile.gettempdir()
    try: entries = list(os.scandir(base))
    except Exception: return
    for entry in entries:
        try:
            if not entry.name.startswith(SPILL_PREFIX) or not entry.is_dir(follow_symlinks=False): continue
            st = entry.stat(follow_symlinks=False)
            if time.time() - st.st_mtime < 900 or (not WINDOWS and st.st_uid != os.getuid()): continue
            shutil.rmtree(entry.path, ignore_errors=True)
        except Exception: pass
def spill(data, cap):
    if len(data) > cap or not SAFE_PATH.match(tempfile.gettempdir()): return {'error': 'host_output_too_large'}
    folder = tempfile.mkdtemp(prefix=SPILL_PREFIX)
    try:
        if not harden(folder): raise RuntimeError('unsafe')
        path = os.path.join(folder, secrets.token_hex(16))
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0), 0o600)
        with os.fdopen(fd, 'wb') as handle: handle.write(data)
        return {'spill': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        return {'error': 'host_output_too_large'}
def terminate_owned(signum=None, frame=None):
    if child is not None:
        try:
            if WINDOWS:
                # No process-group signals on Windows. Kill the tree with taskkill.
                subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            else:
                os.killpg(child.pid, signal.SIGKILL)
        except Exception: pass
        try: child.wait(timeout=15)
        except Exception: pass
    if signum is not None: raise SystemExit(1)
# SIGHUP does not exist on Windows. Register only the signals that exist.
for name in ('SIGHUP', 'SIGTERM', 'SIGINT'):
    signum = getattr(signal, name, None)
    if signum is not None:
        try: signal.signal(signum, terminate_owned)
        except (ValueError, OSError): pass
try:
    # On Windows stdin defaults to the ANSI code page (e.g. cp949), which mangles a
    # UTF-8 payload. Read raw bytes from sys.stdin.buffer and decode as UTF-8 ourselves.
    payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    # Every run clears spills a client never removed (it died, or lost the pointer), not only the next spill.
    sweep()
    if 'cleanup_spill' in payload:
        folder = spill_dir(str(payload['cleanup_spill']))
        if folder is not None: shutil.rmtree(folder, ignore_errors=True)
        print(json.dumps({'cleaned': True} if folder is not None and not os.path.exists(folder) else {'error': 'host_spill_cleanup_failed'}))
        sys.exit(0)
    # Same rule as upstream hermes_constants.py:51-57. Windows uses %LOCALAPPDATA%\hermes.
    root = (pathlib.Path(os.environ.get('LOCALAPPDATA') or (pathlib.Path.home() / 'AppData' / 'Local')) / 'hermes') if WINDOWS else (pathlib.Path.home() / '.hermes')
    root = root / 'hermes-agent'
    folder_name, exe = ('Scripts', 'python.exe') if WINDOWS else ('bin', 'python')
    argv = None
    # How to ask the found Hermes for its version: an install that stopped halfway leaves a folder, sometimes even
    # a Python, but nothing that answers this.
    probe = None
    # On Windows install.ps1 mints hermes.exe (hermes_cli/_launchers.py). A hermes.cmd shim (no distlib) is not used:
    # it is a batch file, and running it here would put the payload through cmd.exe.
    launcher = root / '.hermes' / 'bin' / ('hermes.exe' if WINDOWS else 'hermes')
    if launcher.is_file():
        # Upstream's PM runtime: its launcher names the managed Python it runs Hermes with. The helper starts there
        # the way the launcher starts Hermes (hermes_bootstrap selects the dependency environment), with stdout sent
        # to stderr while that runs so nothing it prints lands in our JSON reply. It comes before the venv: a host
        # moved to the PM runtime can still have its old, no longer used venv.
        try:
            printed = subprocess.run([str(launcher), '--print-runtime-command'], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
            runtime = json.loads(printed.stdout) if printed.returncode == 0 else None
        except Exception: runtime = None
        if isinstance(runtime, list) and runtime and isinstance(runtime[0], str) and os.path.isfile(runtime[0]):
            python = pathlib.Path(runtime[0])
            prelude = '\n'.join([
                'import os, sys',
                'for key in (\'PYTHONHOME\', \'PYTHONPATH\', \'VIRTUAL_ENV\'): os.environ.pop(key, None)',
                'sys.path.insert(0, ' + repr(str(root)) + ')',
                'os.environ[\'HERMES_HOME\'] = os.environ.get(\'HERMES_HOME\') or str(__import__(\'hermes_constants\').get_default_hermes_root())',
                'saved = os.dup(1)',
                'os.dup2(2, 1)',
                'try:',
                '    import hermes_bootstrap',
                'finally:',
                '    sys.stdout.flush()',
                '    os.dup2(saved, 1)',
                '    os.close(saved)',
                'exec(compile(sys.stdin.read(), \'<deskrpg-host-helper>\', \'exec\'), {\'__name__\': \'__main__\'})',
            ])
            argv = [str(python), '-I', '-c', prelude]
            probe = [str(launcher), '--version']
    if argv is None:
        python = next((root / folder / folder_name / exe for folder in ('venv', '.venv') if (root / folder / folder_name / exe).is_file()), None)
        if python is not None:
            argv = [str(python), '-']
            probe = [str(python), '-m', 'hermes_cli.main', '--version']
    def runs():
        try: return subprocess.run(probe, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=str(root), timeout=60).returncode == 0
        except Exception: return False
    # Discovery tells a half-finished install (the folder is there, no Hermes runs) apart from no install at all:
    # the installer refuses an existing folder unless asked to reinstall.
    incomplete = {'candidates': [], 'incomplete': True}
    if argv is None:
        if payload['action'] == 'discover': print(json.dumps(incomplete if root.exists() or root.is_symlink() else {'candidates': []}))
        else: print(json.dumps({'error': 'hermes_not_found'}))
    else:
        spawn = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS else {'start_new_session': True}
        # Pass encoding='utf-8' explicitly. Without it the child's stdin/stdout use the same ANSI
        # code page and break as soon as HOST_HELPER (43K chars, non-ASCII comments) is sent.
        child = subprocess.Popen(argv, text=True, encoding='utf-8', stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **spawn)
        output, unused = child.communicate(payload['script'], timeout=payload['timeout'])
        terminate_owned()
        data = output.encode('utf-8')
        # max_output is the most the client's transport delivers (Windows ssh.exe: 64 KiB). Past it,
        # answer with a short named error instead of a reply that would never arrive whole.
        limit = payload.get('max_output', 262144)
        if child.returncode:
            print(json.dumps(incomplete if payload['action'] == 'discover' and not runs() else {'error': 'host_operation_failed'}))
        elif len(data) > limit:
            print(json.dumps(spill(data, payload.get('max_spill', 262144)) if payload.get('spill') else {'error': 'host_output_too_large'}))
        else:
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
except subprocess.TimeoutExpired:
    # Named like a transport timeout, not a generic failure. A PM Hermes whose dependencies went stale (a plugin
    # removed, an update) rebuilds them on its next launch, and the helper is such a launch: that can take minutes.
    terminate_owned()
    print(json.dumps({'error': 'command_timeout'}))
except Exception:
    terminate_owned()
    print(json.dumps({'error': 'host_operation_failed'}))
`;

/**
 * sh launcher in front of the Python driver. Lets us find and install Hermes even without a system python3
 * (2026-09-19 Dante decision).
 *
 * Args: $1 = run | install, $2 = Python code, $3 = (run) JSON to print verbatim when there's no Python at all.
 * Selection order: Hermes venv Python → system python3 → (install only) fetch a Python into the user's home with uv.
 * uv goes where the Hermes install script itself uses it (`~/.hermes/bin/uv`) — the install script reuses that uv.
 * No sudo. The downloaded install script's output is discarded, and failures are reported only via predefined codes.
 * The Hermes install script requires curl, so only curl is used here too.
 */
export const HOST_LAUNCHER = String.raw`
mode=$1
code=$2
# Before installing, check the system packages the Hermes install script requires but will not install: it only checks
# for git and curl (install.sh stage_prerequisites) and stops if either is missing. With root or passwordless sudo,
# install them here with the package manager; otherwise, or if that fails, stop before minutes of downloading and show
# the admin a one-line command (system-packages.ts).
if [ "$mode" = install ]; then
  # The Node.js runtime the installer fetches on Linux links libatomic.so.1, which minimal images lack; the
  # installer does not check it and fails late with a generic error.
  missing() {
    miss=""
    command -v curl >/dev/null 2>&1 || miss="$miss curl"
    { command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; } || miss="$miss git"
    if [ "$(uname -s)" = Linux ]; then
      found=""
      for f in /lib/libatomic.so.1 /lib64/libatomic.so.1 /usr/lib/libatomic.so.1 /usr/lib64/libatomic.so.1 \
        /lib/*/libatomic.so.1 /usr/lib/*/libatomic.so.1; do [ -e "$f" ] && found=1 && break; done
      [ -n "$found" ] || miss="$miss libatomic"
    fi
  }
  # Package names per manager; keep in step with system-packages.ts.
  names() {
    for p in $miss; do
      case "$1:$p" in apt:libatomic) printf ' libatomic1';; dnf:libatomic) printf ' libatomic';;
        pacman:libatomic) printf ' gcc-libs';; *) printf ' %s' "$p";; esac
    done
  }
  missing
  if [ -n "$miss" ]; then
    as=""; [ "$(id -u)" = 0 ] || as="sudo -n"
    if [ -z "$as" ] || sudo -n true >/dev/null 2>&1; then
      if command -v apt-get >/dev/null 2>&1; then
        $as env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1
        $as env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $(names apt) ca-certificates >/dev/null 2>&1
      elif command -v dnf >/dev/null 2>&1; then $as dnf install -y -q $(names dnf) >/dev/null 2>&1
      elif command -v pacman >/dev/null 2>&1; then $as pacman -Sy --noconfirm $(names pacman) >/dev/null 2>&1
      fi
      missing
    fi
  fi
  if [ -n "$miss" ]; then
    if [ "$(uname -s)" = Darwin ]; then distro=macos
    else distro=$( (. /etc/os-release >/dev/null 2>&1 && printf '%s' "$ID") | tr -cd 'a-z0-9_-' | cut -c1-32); fi
    printf '{"error": "system_packages_missing", "packages": "%s", "distro": "%s"}' "$miss" "$distro"
    exit 0
  fi
fi
# Upstream's PM runtime: its launcher names the managed Python it runs Hermes with (the driver only needs the
# stdlib). It comes first: a host moved to the PM runtime can still have its old, no longer used venv.
pm="$HOME/.hermes/hermes-agent/.hermes/bin/hermes"
if [ -x "$pm" ]; then
  p=$("$pm" --print-runtime-command 2>/dev/null | sed -n 's/^\["\([^"]*\)".*/\1/p')
  if [ -n "$p" ] && [ -x "$p" ]; then exec "$p" -c "$code"; fi
fi
for p in "$HOME/.hermes/hermes-agent/venv/bin/python" "$HOME/.hermes/hermes-agent/.venv/bin/python"; do
  if [ -x "$p" ]; then exec "$p" -c "$code"; fi
done
if command -v python3 >/dev/null 2>&1; then exec python3 -c "$code"; fi
if [ "$mode" != install ]; then printf '%s' "$3"; exit 0; fi
fail() { printf '{"error": "%s"}' "$1"; exit 0; }
[ -n "$HOME" ] && [ -d "$HOME" ] || fail unsafe_host_path
root="$HOME/.hermes"
if [ -L "$root" ] || { [ -e "$root" ] && [ ! -d "$root" ]; }; then fail unsafe_host_path; fi
command -v curl >/dev/null 2>&1 || fail curl_missing
mkdir -p "$root/bin" || fail python_bootstrap_failed
uv="$root/bin/uv"
if [ ! -x "$uv" ]; then
  tmp=$(mktemp "$root/.deskrpg-uv-install.XXXXXX") || fail python_bootstrap_failed
  if ! curl -fsSL --proto '=https' --tlsv1.2 https://astral.sh/uv/install.sh -o "$tmp"; then rm -f "$tmp"; fail hermes_installer_unavailable; fi
  UV_UNMANAGED_INSTALL="$root/bin" UV_NO_MODIFY_PATH=1 sh "$tmp" >/dev/null 2>&1
  rm -f "$tmp"
  [ -x "$uv" ] || fail python_bootstrap_failed
fi
"$uv" python install 3.12 >/dev/null 2>&1 || fail python_bootstrap_failed
py=$("$uv" python find 3.12 2>/dev/null) || fail python_bootstrap_failed
[ -x "$py" ] || fail python_bootstrap_failed
exec "$py" -c "$code"
`;

/**
 * Windows counterpart of `HOST_LAUNCHER`. Does the same thing — picks a Python and passes the body via `-c`.
 *
 * Args come in as **environment variables**, not argv: `DESKRPG_HOST_MODE` = run | install,
 * `DESKRPG_HOST_CODE` = Python code, `DESKRPG_HOST_NONE` = (run) JSON to print when there's no Python at all.
 * `powershell -Command <text> a b c` does not bind `a b c` to `$args` — the leftover tokens are
 * appended after the command text and parsed as PowerShell source as-is (measured on WinServer, 2026-09-20).
 * A `-File` script would fill `$args`, but a temporary `.ps1` file introduces new cleanup, permission, and race
 * issues — so `hostLaunch` carries the values in `execute()`'s spawn environment.
 * They are deleted from the process environment as soon as they're read — the Python child launched next has no
 * reason to inherit the code body.
 *
 * Selection order: the PM runtime Python (`hermes-agent\.hermes\bin\hermes.exe --print-runtime-command`) → Hermes venv
 * Python → python on PATH → (install only) Python fetched with uv.
 * Unlike the POSIX version there's no system package pre-check — install.ps1 fetches PortableGit, uv, Python, and Node
 * itself, so neither sudo nor a package manager is needed (confirmed in upstream scripts/install.ps1).
 * The Windows venv Python is `Scripts\python.exe` (upstream gateway_windows.py:1457,1475).
 */
export const HOST_LAUNCHER_PS = String.raw`
$ErrorActionPreference = 'Stop'
$mode = $env:DESKRPG_HOST_MODE
$code = $env:DESKRPG_HOST_CODE
$none = $env:DESKRPG_HOST_NONE
Remove-Item Env:\DESKRPG_HOST_MODE -ErrorAction SilentlyContinue
Remove-Item Env:\DESKRPG_HOST_CODE -ErrorAction SilentlyContinue
Remove-Item Env:\DESKRPG_HOST_NONE -ErrorAction SilentlyContinue
function Fail($c) { [Console]::Out.Write('{"error": "' + $c + '"}'); exit 0 }
function Run($exe) { & $exe -c $code; exit $LASTEXITCODE }
$home2 = $env:USERPROFILE
if (-not $home2 -or -not (Test-Path -LiteralPath $home2 -PathType Container)) { Fail 'unsafe_host_path' }
# Same rule as upstream hermes_constants.py:51-57. The default Windows home is not ~/.hermes.
$base = $env:LOCALAPPDATA
if (-not $base) { $base = Join-Path (Join-Path $home2 'AppData') 'Local' }
$root = Join-Path $base 'hermes'
# Upstream's PM runtime (install.ps1): the launcher names the managed Python it runs Hermes with. It comes first: a host
# moved to the PM runtime can still have its old, no longer used venv. Only the .exe; a .cmd shim is a batch file.
$pm = Join-Path (Join-Path $root 'hermes-agent') '.hermes\bin\hermes.exe'
if (Test-Path -LiteralPath $pm -PathType Leaf) {
  $runtime = $null
  try {
    $printed = (& $pm --print-runtime-command 2>$null | Out-String)
    if ($LASTEXITCODE -eq 0 -and $printed) { $runtime = @($printed | ConvertFrom-Json) }
  } catch { $runtime = $null }
  if ($runtime -and $runtime.Count -gt 0 -and $runtime[0] -is [string] -and (Test-Path -LiteralPath $runtime[0] -PathType Leaf)) { Run $runtime[0] }
}
foreach ($f in @('venv', '.venv')) {
  $p = Join-Path (Join-Path (Join-Path $root 'hermes-agent') $f) 'Scripts\python.exe'
  if (Test-Path -LiteralPath $p -PathType Leaf) { Run $p }
}
$sys = Get-Command python -ErrorAction SilentlyContinue
if ($sys) { Run $sys.Source }
if ($mode -ne 'install') { [Console]::Out.Write($none); exit 0 }
$item = Get-Item -LiteralPath $root -ErrorAction SilentlyContinue
if ($item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $item.PSIsContainer)) { Fail 'unsafe_host_path' }
New-Item -ItemType Directory -Force -Path (Join-Path $root 'bin') | Out-Null
$uv = Join-Path $root 'bin\uv.exe'
if (-not (Test-Path -LiteralPath $uv -PathType Leaf)) {
  $tmp = Join-Path $root ('.deskrpg-uv-install.' + [Guid]::NewGuid().ToString('N') + '.ps1')
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri 'https://astral.sh/uv/install.ps1' -OutFile $tmp
  } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; Fail 'hermes_installer_unavailable' }
  $env:UV_UNMANAGED_INSTALL = Join-Path $root 'bin'
  $env:UV_NO_MODIFY_PATH = '1'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $tmp *> $null
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $uv -PathType Leaf)) { Fail 'python_bootstrap_failed' }
}
& $uv python install 3.12 *> $null
if ($LASTEXITCODE -ne 0) { Fail 'python_bootstrap_failed' }
$py = (& $uv python find 3.12 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $py -or -not (Test-Path -LiteralPath $py -PathType Leaf)) { Fail 'python_bootstrap_failed' }
Run $py
`;

/** Command to launch the Python launcher on the host. The shell differs per platform; argument order is the same. */
export function hostLaunch(
  platform: string,
  mode: "run" | "install",
  code: string,
  none = "",
): { command: string; args: string[]; env?: Record<string, string> } {
  if (isWindows(platform))
    return {
      command: "powershell",
      // `-Command <text> a b c` doesn't bind a, b, c to $args (see the HOST_LAUNCHER_PS comment above).
      // So the payload is sent via execute()'s spawn environment, not argv.
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        HOST_LAUNCHER_PS,
      ],
      env: { DESKRPG_HOST_MODE: mode, DESKRPG_HOST_CODE: code, DESKRPG_HOST_NONE: none },
    };
  return { command: "sh", args: ["-c", HOST_LAUNCHER, "deskrpg", mode, code, none] };
}

/**
 * Hermes install-only script. It must run when there's no install, so instead of going through HOST_BOOTSTRAP
 * (= the Hermes venv Python) it runs on the Python HOST_LAUNCHER picked (system python3, else a uv-fetched Python).
 * Stdlib only. The install script is downloaded to a temp file rather than piped, its sha256 fingerprint is kept,
 * and it runs as `bash <file>`.
 * Install output is neither stored nor returned — only the last 8KiB is kept in memory for failure classification.
 */
export const HOST_INSTALLER = String.raw`
import hashlib, json, os, pathlib, stat, subprocess, sys, tempfile, threading, time, urllib.request
WINDOWS = sys.platform == 'win32'
INSTALLER_URL = 'https://hermes-agent.nousresearch.com/install.ps1' if WINDOWS else 'https://hermes-agent.nousresearch.com/install.sh'
INSTALLER_SUFFIX = '.ps1' if WINDOWS else '.sh'
MAX_INSTALLER_BYTES = 1048576
INSTALL_TIMEOUT = 580
TAIL = 8192
MAX_LINE = 4096
# Only the markers in the table are considered. Order is priority, and a line folds into its first match only.
# Marker strings were picked from the install script's actual output (checked against install.sh's log_info text).
# At first 'clone' was treated as a literal, but git prints 'Cloning into ...', so it never matched.
MILESTONE_RULES = (
    ('deps', lambda text: 'installing managed uv' in text or 'installing dependencies' in text or 'installing git' in text),
    ('clone', lambda text: 'clon' in text or 'fetching repository' in text),
    ('venv', lambda text: 'creating virtual environment' in text or 'virtual environment' in text),
    ('node_modules', lambda text: 'node.js dependencies' in text or 'npm install' in text or 'desktop workspace dependencies' in text),
    ('skills', lambda text: 'bundled skills' in text or 'skills to' in text),
    ('done', lambda text: 'installation complete' in text),
)
milestones = []
def note(line):
    # The line content is never kept anywhere — it's folded up only into predefined codes.
    if not line: return
    text = line.decode('utf-8', errors='replace').lower()
    for code, matches in MILESTONE_RULES:
        if matches(text):
            if code not in milestones: milestones.append(code)
            return
def out(value):
    sys.stdout.write(json.dumps(value))
    raise SystemExit(0)
# Set to True (prepended by the caller) when the user chose to reinstall over an install that stopped halfway.
REINSTALL = globals().get('REINSTALL') is True
def runnable():
    # Does anything in the existing folder answer '--version'? The same check as after a fresh install below.
    folder_name, exe = ('Scripts', 'python.exe') if WINDOWS else ('bin', 'python')
    python = next((INSTALL / folder / folder_name / exe for folder in ('venv', '.venv') if (INSTALL / folder / folder_name / exe).is_file()), None)
    launcher = INSTALL / '.hermes' / 'bin' / ('hermes.exe' if WINDOWS else 'hermes')
    if python is None and not launcher.is_file(): return False
    argv = [str(python), '-m', 'hermes_cli.main', '--version'] if python is not None else [str(launcher), '--version']
    try: return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=str(INSTALL), env={**os.environ, 'HERMES_HOME': str(ROOT), 'PYTHONDONTWRITEBYTECODE': '1'}, timeout=120).returncode == 0
    except Exception: return False
try:
    ROOT = (pathlib.Path(os.environ.get('LOCALAPPDATA') or (pathlib.Path.home() / 'AppData' / 'Local')) / 'hermes') if WINDOWS else (pathlib.Path.home() / '.hermes')
    INSTALL = ROOT / 'hermes-agent'
    if ROOT.is_symlink() or (ROOT.exists() and not ROOT.is_dir()): out({'error': 'unsafe_host_path'})
    # Upgrading is out of scope for this path. An existing folder is never touched, except a half-finished one the
    # user chose to reinstall over (checked again under the lock).
    if (INSTALL.exists() or INSTALL.is_symlink()) and not REINSTALL: out({'error': 'hermes_already_installed'})
    ROOT.mkdir(parents=True, exist_ok=True)
    lock_path = ROOT / '.deskrpg-setup.lock'
    if WINDOWS:
        # No O_NOFOLLOW. Path.is_symlink() doesn't catch Windows junctions (CPython's os.stat doesn't
        # report junctions as symlinks) — check the reparse point bit directly. Pass if the file doesn't exist yet.
        try:
            attrs = getattr(os.stat(lock_path, follow_symlinks=False), 'st_file_attributes', 0)
        except FileNotFoundError:
            attrs = 0
        if attrs & stat.FILE_ATTRIBUTE_REPARSE_POINT: out({'error': 'unsafe_host_path'})
        import msvcrt
        fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
        # os.open follows reparse points (symlinks/junctions) and opens a handle to the target file — that handle's fstat
        # doesn't report the reparse bit, so if the path was swapped between the reparse-point check above and this open, this
        # recheck can't catch it. It doesn't close the TOCTOU window; it only defends the rare remaining case (where the
        # handle still points at the reparse point itself).
        if getattr(os.fstat(fd), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            os.close(fd)
            out({'error': 'unsafe_host_path'})
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError:
            os.close(fd)
            out({'error': 'host_busy'})
    else:
        import fcntl; fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            out({'error': 'host_busy'})
    lock = os.fdopen(fd, 'w')
    # Check once more after taking the lock — a competing install may have just finished.
    reinstalled = False
    if INSTALL.exists() or INSTALL.is_symlink():
        if not REINSTALL or INSTALL.is_symlink() or not INSTALL.is_dir() or runnable(): out({'error': 'hermes_already_installed'})
        # Moved aside, not deleted: whatever the failed install left (and anything the user put there) stays.
        backup = ROOT / ('hermes-agent.incomplete-' + time.strftime('%Y%m%d-%H%M%S'))
        try: INSTALL.rename(backup)
        except OSError: out({'error': 'hermes_install_failed'})
        reinstalled = True
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(INSTALLER_URL, timeout=30) as response:
            body = response.read(MAX_INSTALLER_BYTES + 1)
    except Exception:
        out({'error': 'hermes_installer_unavailable'})
    if not body or len(body) > MAX_INSTALLER_BYTES: out({'error': 'hermes_installer_unavailable'})
    digest = hashlib.sha256(body).hexdigest()
    handle, script = tempfile.mkstemp(prefix='.deskrpg-hermes-install-', suffix=INSTALLER_SUFFIX, dir=str(ROOT))
    try:
        with os.fdopen(handle, 'wb') as stream:
            stream.write(body); stream.flush(); os.fsync(stream.fileno())
        env = {**os.environ, 'HERMES_HOME': str(ROOT), 'PYTHONDONTWRITEBYTECODE': '1'}
        if WINDOWS:
            # Switch names are measured from upstream scripts/install.ps1:15-60. The counterpart of POSIX's --skip-browser
            # is -SkipComputerUse, not -SkipBrowser.
            argv = ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-SkipComputerUse', '-SkipSetup', '-NonInteractive']
            extra = {}
        else:
            argv = ['bash', script, '--skip-browser', '--skip-setup']
            extra = {'pass_fds': (lock.fileno(),)}
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=str(ROOT), **extra)
        watchdog = threading.Timer(INSTALL_TIMEOUT, child.kill)
        watchdog.start()
        tail = b''
        buffered = b''
        try:
            while True:
                chunk = child.stdout.read(65536)
                if not chunk: break
                # Read and discard. A normal install's output exceeds 256KiB, so no cap — keep only the tail.
                tail = (tail + chunk)[-TAIL:]
                pieces = (buffered + chunk).split(b'\n')
                # Also truncate the leftover fragment so output without newlines can't crowd memory.
                buffered = pieces.pop()[-MAX_LINE:]
                for piece in pieces: note(piece[-MAX_LINE:])
            note(buffered)
            code = child.wait()
        finally:
            watchdog.cancel()
            child.stdout.close()
    finally:
        try: os.unlink(script)
        except OSError: pass
    if code != 0:
        diagnostic = tail.decode('utf-8', errors='replace').lower()
        if 'could not resolve host' in diagnostic or 'failed to connect' in diagnostic or 'connection refused' in diagnostic:
            out({'error': 'hermes_installer_unavailable'})
        # install.sh stage_prerequisites text; older installers said they could not install git automatically.
        if 'git is required' in diagnostic or 'could not install git automatically' in diagnostic: out({'error': 'git_missing'})
        out({'error': 'hermes_install_failed'})
    folder_name, exe = ('Scripts', 'python.exe') if WINDOWS else ('bin', 'python')
    python = next((INSTALL / folder / folder_name / exe for folder in ('venv', '.venv') if (INSTALL / folder / folder_name / exe).is_file()), None)
    # Upstream's current installer sets up the PM runtime: no venv, a launcher that runs Hermes with its dependencies.
    launcher = INSTALL / '.hermes' / 'bin' / ('hermes.exe' if WINDOWS else 'hermes')
    if python is None and not launcher.is_file(): out({'error': 'hermes_install_failed'})
    probe = subprocess.run([str(python), '-m', 'hermes_cli.main', '--version'] if python is not None else [str(launcher), '--version'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=str(INSTALL), env={**os.environ, 'HERMES_HOME': str(ROOT), 'PYTHONDONTWRITEBYTECODE': '1'}, timeout=120)
    if probe.returncode: out({'error': 'hermes_install_failed'})
    out({'ok': True, 'installerDigest': digest, 'milestones': milestones, **({'reinstalled': True} if reinstalled else {})})
except SystemExit:
    raise
except Exception:
    sys.stdout.write(json.dumps({'error': 'host_operation_failed'}))
`;

// Only fixed operations are accepted. Raw subprocess output, configuration, env and exceptions never leave here.
export const HOST_HELPER = String.raw`
import hashlib, json, os, pathlib, plistlib, re, secrets, shlex, socket, stat, subprocess, sys, tempfile, time, urllib.request, urllib.error
try:
    import yaml
except ImportError:
    # Upstream's PM runtime no longer ships PyYAML; its own YAML module has the same safe_load/safe_dump.
    import hermes_yaml as yaml
WINDOWS = sys.platform == 'win32'
# Same rule as upstream hermes_constants.py:51-57. On Windows it's %LOCALAPPDATA%\hermes.
ROOT = (pathlib.Path(os.environ.get('LOCALAPPDATA') or (pathlib.Path.home() / 'AppData' / 'Local')) / 'hermes') if WINDOWS else (pathlib.Path.home() / '.hermes')
INSTALL = ROOT / 'hermes-agent'
# Upstream's PM runtime: no venv, a managed Python, and this launcher, which runs Hermes with its dependencies
# (it is what 'hermes gateway install' puts in ExecStart). Where it exists it is what Hermes runs on, even if an old
# venv is still there from before the move.
def pm_launcher():
    """Upstream's PM launcher. On Windows install.ps1 mints hermes.exe (hermes_cli/_launchers.py); a hermes.cmd minted
    when distlib is missing does not count: Hermes ignores a .cmd/.bat HERMES_BIN on Windows and falls back to the
    module form (kanban_db_dispatch _hermes_path_argv), so only the .exe can serve as the launcher."""
    return INSTALL / '.hermes' / 'bin' / ('hermes.exe' if sys.platform == 'win32' else 'hermes')
LAUNCHER = pm_launcher()
PM_RUNTIME = LAUNCHER.is_file()
# Kanban workers start as '$HERMES_BIN -p <profile> ...' when it is set, else as '<gateway python> -m hermes_cli.main'
# without the gateway's PYTHONPATH, which cannot import Hermes on the PM runtime. On systemd the wizard sets it in this
# one drop-in, and the service check accepts exactly this drop-in and no other. On macOS and Windows it goes into the
# Hermes .env instead (see set-worker-launch).
WORKER_LAUNCH_DROPIN = 'hermes-bin.conf'
def worker_launch_dropin_text():
    value = str(LAUNCHER).replace('\\', '\\\\').replace('"', '\\"')
    return '[Service]\n# Written by the DeskRPG setup wizard: kanban workers start through the Hermes launcher.\nEnvironment="HERMES_BIN=' + value + '"\n'
def pm_launchd_shell(name, home):
    """The shell command inside the plist upstream's 'hermes gateway install' writes on the PM runtime
    (hermes_cli/gateway_launchd.py generate_launchd_plist): the launcher runs through the stderr timestamper and logs
    under <home>/logs."""
    logs = home / 'logs'
    stdout_log, stderr_log = str(logs / 'gateway.log'), str(logs / 'gateway.error.log')
    profile = ['--profile', name] if name != 'default' else []
    command = [str(LAUNCHER), '--run-module', 'hermes_cli.stderr_timestamp', '--error-log', stderr_log, '--', str(LAUNCHER)] + profile + ['gateway', 'run', '--external-supervisor']
    return 'exec ' + shlex.join(command) + ' >> ' + shlex.quote(stdout_log) + ' 2>> ' + shlex.quote(stderr_log)
def pm_launchd_arguments(name, home):
    """ProgramArguments around that shell command (launchd_program_arguments): osascript gives the job a Local Network
    identity. Upstream 8682d5791b (2026-09-27) moved the wrapper from AppleScript to JXA."""
    shell = pm_launchd_shell(name, home)
    script = 'ObjC.import("stdlib"); const status=$.system(' + json.dumps(shell) + '); const signal=status & 127; $.exit(status === -1 ? 1 : signal === 0 ? (status >> 8) & 255 : 128 + signal);'
    return ['/usr/bin/osascript', '-l', 'JavaScript', '-e', script]
def pm_launchd_legacy_arguments(name, home):
    """The AppleScript wrapper upstream wrote before 8682d5791b, around the same shell command. A gateway installed
    back then keeps this plist until 'hermes gateway restart' refreshes it, so it is still upstream's own service."""
    applescript = pm_launchd_shell(name, home).replace('\\', '\\\\').replace('"', '\\"')
    return ['/usr/bin/osascript', '-e', 'do shell script "' + applescript + '"']
def hermes_argv(*args):
    """A Hermes CLI command: the PM launcher, or the old venv interpreter with -m."""
    return ([str(LAUNCHER)] if PM_RUNTIME else [sys.executable, '-m', 'hermes_cli.main']) + list(args)
sys.dont_write_bytecode = True
sys.path.insert(0, str(INSTALL))
os.environ['HERMES_HOME'] = str(ROOT)
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
NAME = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')
# Only check the shape of the model provider name (measured value: 'openai-codex'). If it's not the shape, don't judge — unknown.
PROVIDER = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')
# Provider ids that route to Hermes' generic custom endpoint, which has no login (hermes_cli/auth.py alias table:
# local, ollama, vllm, llamacpp, llama.cpp, llama-cpp -> custom). The auth command reports them as logged out.
CUSTOM_ALIASES = {'custom','local','ollama','vllm','llamacpp','llama.cpp','llama-cpp'}
# Runtime identities outside the provider registry (is_runtime_provider_routable). The auth command
# always reports them as logged out, so its answer says nothing about whether chat works.
UNREPORTED = {'auto','openrouter','moa'}
# LM Studio is a registry provider that runs without a key (auth.py uses a no-auth placeholder).
KEYLESS = {'lmstudio','lm-studio','lm_studio'}
def text(value):
    return value.strip() if isinstance(value, str) else ''
def named_endpoint(cfg, name):
    """Whether config.yaml defines a providers:/custom_providers: entry for name with an endpoint URL."""
    entries = cfg.get('providers')
    entry = entries.get(name) if isinstance(entries, dict) else None
    if isinstance(entry, dict):
        return any(text(entry.get(k)) for k in ('api','base_url','url'))
    legacy = cfg.get('custom_providers')
    for entry in legacy if isinstance(legacy, list) else []:
        if isinstance(entry, dict) and text(entry.get('name')).lower() == name and text(entry.get('base_url')):
            return True
    return False
def model_state(cfg, home):
    """ready / missing / unknown for the profile's chat model. Key values are never read or returned."""
    block = cfg.get('model')
    block = block if isinstance(block, dict) else {}
    provider = text(block.get('provider')) or text(cfg.get('provider'))
    provider = provider.lower()
    model = text(block.get('default')) or text(block.get('model')) or text(cfg.get('model'))
    base_url = text(block.get('base_url'))
    if not provider and not model and not base_url: return 'missing'
    if provider and not PROVIDER.fullmatch(provider): return 'unknown'
    # A base URL with no provider pin is Hermes' bare custom endpoint.
    if provider in CUSTOM_ALIASES or (not provider and base_url):
        return 'ready' if base_url and model else 'unknown'
    if provider.startswith('custom:'):
        return 'ready' if model and named_endpoint(cfg, provider[len('custom:'):]) else 'unknown'
    if provider in KEYLESS: return 'ready' if model else 'unknown'
    if not provider or provider in UNREPORTED: return 'unknown'
    if named_endpoint(cfg, provider): return 'ready' if model else 'unknown'
    try:
        auth = run(hermes_argv('auth', 'status', provider), timeout=45, env={**os.environ, 'HERMES_HOME': str(home)})
    except Exception:
        return 'unknown'
    # Measured output is one line: 'openai-codex: logged in'. The raw text is neither stored nor returned.
    if auth.returncode == 0 and 'logged in' in (auth.stdout or '').lower(): return 'ready'
    return 'missing'
RESERVED = {'hermes','test','tmp','root','sudo'}
# Excluded from names the wizard can newly create or issue keys for. 'default' is handled by configure.
RESERVED_PROFILE = RESERVED | {'default'}
PIN = '49959b71876304c197796e64f9bc21d314fe6a7b'
PLUGIN_VERSION = '0.32.0'
HERMES_MIN = '0.21.1'
SOURCE = 'https://github.com/dandacompany/deskrpg-hermes-plugin'
TIMEZONE = re.compile(r'^[A-Za-z][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-.]+)*$')
LOCK = None
PORT_MIN = 8642
PORT_MAX = 8699
# Restart waits for the gateway's graceful shutdown (drain). Service stop limit + startup slack; never below 90s (the value
# Hermes itself uses for systemctl restart / launchctl kickstart -k) and never above 300s.
RESTART_MIN = 90
RESTART_MAX = 300
RESTART_START_MARGIN = 30
# Windows restart through Hermes' own CLI: it drains up to 30s, waits up to 40s for the old process,
# then starts and waits for the new one. The restart budget is this plus RESTART_START_MARGIN.
WINDOWS_RESTART_SECONDS = 120
# Plugin 0.16.0 worker propagation opt-in. The plugin only reads this value — the operator (and this wizard) turns it on.
WORKER_ENV = 'DESKRPG_WORKER_PROPAGATION'
WORKER_TRUTHY = ('1', 'true', 'yes', 'on')
class Failure(Exception): pass
def fail(code): raise Failure(code)
def version_parts(value):
    parts = []
    for chunk in str(value or '').split('.'):
        match = re.match(r'^\d+', chunk)
        if not match: break
        parts.append(int(match.group(0)))
    return parts
def version_below(value, minimum):
    # Unreadable, absent or non-numeric versions never block; only a confidently lower number does.
    if not isinstance(value, str) or not value or value == 'unknown': return False
    left, right = version_parts(value), version_parts(minimum)
    if not left: return False
    size = max(len(left), len(right))
    return tuple(left + [0] * (size - len(left))) < tuple(right + [0] * (size - len(right)))
def read(path):
    if path.is_symlink(): fail('unsafe_host_path')
    if path.exists() and path.stat().st_size > 1048576: fail('invalid_host_config')
    return path.read_text(encoding='utf-8-sig') if path.exists() else ''
def config(home):
    value = yaml.safe_load(read(home / 'config.yaml')) or {}
    if not isinstance(value, dict): fail('invalid_host_config')
    return value
def envfile(home):
    # Hermes's supported parser: profile-local only, never inherited process credentials.
    read(home / '.env')
    from agent.secret_scope import load_env_file
    return load_env_file(home / '.env')
def mapping(value):
    if value is None: return {}
    if not isinstance(value, dict): fail('invalid_host_config')
    return value
def settings(home):
    cfg = config(home)
    gateway = mapping(cfg.get('gateway'))
    block = {}
    for entry in (mapping(gateway.get('platforms')).get('api_server'), mapping(cfg.get('platforms')).get('api_server'), gateway.get('api_server')):
        entry = mapping(entry)
        extra = {**mapping(block.get('extra')), **mapping(entry.get('extra'))}
        block.update(entry)
        block['extra'] = extra
    extra = mapping(block.get('extra'))
    for key in ('key','host','port'):
        if key in block and key not in extra: extra[key] = block[key]
    env = envfile(home)
    token = env.get('API_SERVER_KEY') or extra.get('key') or ''
    port = env.get('API_SERVER_PORT') or extra.get('port') or 8642
    try: port = int(port)
    except (ValueError, TypeError): fail('invalid_host_config')
    if not 1024 <= port <= 65535: fail('invalid_host_config')
    if not isinstance(token, str): fail('invalid_host_config')
    external = any(mapping(v).get('enabled') for v in mapping(cfg.get('secrets')).values())
    # Resolve secret-provider references only through Hermes, never replace them with a newly minted value.
    if token.startswith((chr(36) + '{', 'op://', 'bw://')): external = True
    return cfg, env, token, port, external

def run(argv, timeout=8, env=None):
    # errors='replace': schtasks on Korean Windows prints in code page 949. Don't lose the verdict to a decode exception.
    return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors='replace', timeout=timeout, env=env)
def same_path(left, right):
    # Windows is case-insensitive, and the launcher preserves HERMES_HOME's spelling as-is (upstream _preserve_hermes_home_path).
    try: return os.path.normcase(str(pathlib.Path(left).resolve())) == os.path.normcase(str(pathlib.Path(right).resolve()))
    except OSError: return False
def unxml(value):
    # Upstream task XML uses xml.sax.saxutils.escape — only & < > change, so only those three need reverting.
    return value.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
def unit_stop_seconds(definition):
    # The systemd unit Hermes writes has TimeoutStopSec=<int> (gateway_service_unit.py). Other shapes are unknown.
    match = re.search(r'^TimeoutStopSec=(\d+)\s*$', definition, re.M)
    return int(match.group(1)) if match else None
def plist_stop_seconds(data):
    # launchd's ExitTimeOut (Hermes uses 60 — the user domain caps it at 60s). bool is a subtype of int, so block it separately.
    value = data.get('ExitTimeOut')
    return value if isinstance(value, int) and not isinstance(value, bool) else None
def restart_timeout(owner):
    stop = owner.get('stop')
    wait = (stop if isinstance(stop, int) and stop > 0 else 0) + RESTART_START_MARGIN
    return min(RESTART_MAX, max(RESTART_MIN, wait))
def cli_drains():
    # Does the installed Hermes restart its Windows gateway with a drain (planned-stop marker, then wait)?
    # Read the module source instead of importing it: importing a CLI module can have side effects.
    try:
        import importlib.util
        spec = importlib.util.find_spec('hermes_cli.gateway_windows')
        source = read(pathlib.Path(spec.origin)) if spec and spec.origin else ''
    except Exception: return False
    return 'write_planned_stop_marker' in source and re.search(r'^def restart\(', source, re.M) is not None
def windows_restart(task, name, home, python):
    # schtasks /End ends the task at once and can cut off a running card or cron job. Hermes' own
    # 'gateway restart' writes the planned-stop marker, lets the gateway drain, ends the task, waits for it
    # to be gone and starts it again. Use it when the installed Hermes has it; otherwise keep /End + /Run.
    # Returns (command, env, stop seconds).
    if cli_drains():
        restart = (['--profile', name] if name != 'default' else []) + ['gateway', 'restart']
        # On the PM runtime a bare 'python -m' misses the dependency environment the launcher selects.
        command = hermes_argv(*restart) if PM_RUNTIME else [python, '-m', 'hermes_cli.main'] + restart
        # The CLI prints non-ASCII status marks; on a cp949 pipe that would raise mid-restart.
        env = {**os.environ, 'HERMES_HOME': str(home), 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}
        return command, env, WINDOWS_RESTART_SECONDS
    return ['cmd', '/c', 'schtasks /End /TN ' + task + ' & schtasks /Run /TN ' + task], None, None
def launches(arguments, target):
    # wscript.exe runs the 'first' argument that isn't a switch (//B, //Nologo). Look only at that one actually executed —
    # someone else's task that appends our launcher path after it must not pass.
    for token in re.finditer(r'"([^"]*)"|(\S+)', arguments):
        value = unxml(token.group(1) or token.group(2) or '')
        if value.startswith('//'): continue
        return same_path(value, target)
    return False
def homes():
    result = [('default', ROOT)]
    profiles = ROOT / 'profiles'
    if profiles.is_symlink(): fail('unsafe_host_path')
    if profiles.is_dir():
        for child in sorted(profiles.iterdir()):
            if NAME.fullmatch(child.name) and child.name not in RESERVED and child.name != 'default' and child.is_dir() and not child.is_symlink() and not (child / '.deleted').exists():
                result.append((child.name, child))
    return result

def identity(name, home):
    suffix = '' if name == 'default' else '-' + name
    definition, service, command, pid, warning = '', 'manual', None, 0, 'managed_service_required'
    # Time (seconds) the service can use for graceful shutdown. None if unknown — the restart limit uses the lower bound.
    stop = None
    # Extra environment for the restart command (Windows CLI restart pins HERMES_HOME). None keeps ours.
    restart_env = None
    # PM runtime only: 'ok' when the service sets HERMES_BIN to the launcher, 'missing' when the wizard should add it.
    launch = None
    python = str(pathlib.Path(sys.executable))
    if sys.platform == 'darwin':
        label = 'ai.hermes.gateway' + suffix
        path = pathlib.Path.home() / 'Library' / 'LaunchAgents' / (label + '.plist')
        if path.exists():
            definition = read(path)
            data = plistlib.loads(definition.encode())
            stop = plist_stop_seconds(data)
            args = data.get('ProgramArguments', [])
            env = data.get('EnvironmentVariables', {})
            valid = data.get('Label') == label and env.get('HERMES_HOME') == str(home)
            if PM_RUNTIME:
                # Upstream's PM plist, argument for argument (the profile is inside the osascript program), in either
                # wrapper upstream has written. Anything else is not upstream's service.
                valid = valid and args in (pm_launchd_arguments(name, home), pm_launchd_legacy_arguments(name, home))
            else:
                valid = valid and len(args) >= 4
                valid = valid and pathlib.Path(args[0]).parent.resolve() == pathlib.Path(python).parent.resolve() and pathlib.Path(args[0]).name in ('python', 'python3', pathlib.Path(python).name) and 'gateway' in args and 'run' in args
                valid = valid and 'hermes_cli.main' in args
                expected_profile = ['--profile', name] if name != 'default' else []
                for flag in ('--profile', '-p'):
                    if flag in args and (name == 'default' or args[args.index(flag)+1:args.index(flag)+2] != [name]): valid = False
                if expected_profile and '--profile' not in args and '-p' not in args: valid = False
            valid = valid and not any(k.startswith(('API_SERVER_', 'GATEWAY_MULTIPLEX')) for k in env)
            service = label
            if valid:
                matches = []
                found_unmatched = False
                for domain in ('gui/' + str(os.getuid()), 'user/' + str(os.getuid())):
                    state = run(['launchctl', 'print', domain + '/' + label])
                    if state.returncode == 0:
                        loaded_args = re.search(r'^\s*arguments = \{\n(.*?)^\s*\}', state.stdout, re.M | re.S)
                        actual_args = [line.strip() for line in loaded_args.group(1).splitlines()] if loaded_args else None
                        loaded_home = re.search(r'^\s*HERMES_HOME\s*=>?\s*(.*?)\s*$', state.stdout, re.M)
                        if not loaded_home or loaded_home.group(1) != str(home) or actual_args != args:
                            found_unmatched = True
                            continue
                        matches.append(domain)
                        match = re.search(r'^\s*pid = (\d+)', state.stdout, re.M)
                        pid = int(match.group(1)) if match else 0
                if len(matches) == 1 and not found_unmatched:
                    service = matches[0] + '/' + label
                    command = ['launchctl', 'kickstart', '-k', service]
                    warning = None
                elif not matches and not found_unmatched:
                    # Same managername rule as Hermes's _probe_launchd_domain_for_label.
                    manager = run(['launchctl','managername'])
                    domain = ('gui/' if 'Aqua' in manager.stdout else 'user/') + str(os.getuid())
                    if manager.returncode == 0 and run(['launchctl','print',domain]).returncode == 0 and data.get('RunAtLoad') is True:
                        service = domain + '/' + label
                        command = ['launchctl','bootstrap',domain,str(path)]
                        warning = None
                    else: warning = 'managed_service_required'
                else: warning = 'service_identity_mismatch' if found_unmatched else 'service_identity_ambiguous'
                # The gateway loads <home>/.env into its environment at start; that is where the wizard puts it.
                if PM_RUNTIME and command: launch = 'ok' if envfile(home).get('HERMES_BIN') == str(LAUNCHER) else 'missing'
            else: warning = 'service_identity_mismatch'
    elif sys.platform.startswith('linux'):
        service = 'hermes-gateway' + suffix + '.service'
        path = pathlib.Path.home() / '.config' / 'systemd' / 'user' / service
        if path.exists():
            definition = read(path)
            stop = unit_stop_seconds(definition)
            state = run(['systemctl', '--user', 'show', service, '--property=FragmentPath,DropInPaths,MainPID,Environment,ExecStart'])
            props = dict(line.split('=',1) for line in state.stdout.splitlines() if '=' in line)
            pinned = 'HERMES_HOME=' + str(home)
            # Any drop-in can change how the gateway starts, so only the wizard's own HERMES_BIN drop-in, byte for
            # byte, is accepted.
            drop_ins = props.get('DropInPaths', '').split()
            own_drop_in = path.parent / (service + '.d') / WORKER_LAUNCH_DROPIN
            drop_ins_ok = not drop_ins or (PM_RUNTIME and drop_ins == [str(own_drop_in)] and read(own_drop_in) == worker_launch_dropin_text())
            valid = state.returncode == 0 and props.get('FragmentPath') == str(path) and drop_ins_ok
            service_env = dict(v.split('=',1) for v in shlex.split(props.get('Environment','')) if '=' in v)
            valid = valid and service_env.get('HERMES_HOME') == str(home) and pinned in definition
            live_exec = re.search(r'argv\[\]=(.*?)\s*;', props.get('ExecStart',''))
            live_args = shlex.split(live_exec.group(1)) if live_exec else []
            disk_execs = re.findall(r'^ExecStart=(.+)$', definition, re.M)
            disk_args = shlex.split(disk_execs[0]) if len(disk_execs) == 1 else []
            profile_args = ['--profile',name] if name != 'default' else []
            if PM_RUNTIME:
                # Upstream's PM unit (hermes gateway install): ExecStart="<launcher>" [--profile <name>] "gateway" "run".
                valid = valid and live_args == disk_args and live_args == [str(LAUNCHER)] + profile_args + ['gateway','run']
            else:
                expected_tail = ['-m','hermes_cli.main'] + profile_args + ['gateway','run']
                valid = valid and live_args == disk_args and bool(live_args) and live_args[1:] == expected_tail
                valid = valid and pathlib.Path(live_args[0]).parent.resolve() == pathlib.Path(python).parent.resolve() and pathlib.Path(live_args[0]).name in ('python','python3',pathlib.Path(python).name)
            valid = valid and not re.search(r'(API_SERVER_|GATEWAY_MULTIPLEX|EnvironmentFile)', definition + props.get('Environment',''))
            if name != 'default': valid = valid and ('--profile ' + name) in props.get('ExecStart','')
            else: valid = valid and not re.search(r'--profile| -p ', props.get('ExecStart',''))
            if valid:
                command = ['systemctl', '--user', 'restart', service]
                pid = int(props.get('MainPID') or '0')
                warning = None
                if PM_RUNTIME: launch = 'ok' if service_env.get('HERMES_BIN') == str(LAUNCHER) else 'missing'
            else: warning = 'service_identity_mismatch'
    elif sys.platform == 'win32':
        # Upstream gateway_windows.py naming convention. The task name has the profile name as a suffix, and
        # both the task and the Startup folder fallback launch <HERMES_HOME>/gateway-service/<task name>.vbs.
        # The .cmd in the same place is a compatibility leftover from upstream, not what actually runs — look at the .vbs.
        task = 'Hermes_Gateway' + ('_' + name if name != 'default' else '')
        service = task
        stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', task)
        launcher = next((base / 'gateway-service' / (stem + '.vbs') for base in (home, ROOT) if (base / 'gateway-service' / (stem + '.vbs')).is_file()), None)
        registered = run(['schtasks', '/Query', '/TN', task, '/XML'])
        definition = registered.stdout if registered.returncode == 0 else ''
        startup = pathlib.Path(os.environ.get('APPDATA') or (pathlib.Path.home() / 'AppData' / 'Roaming')) / 'Microsoft' / 'Windows' / 'Start Menu' / 'Programs' / 'Startup' / (stem + '.vbs')
        if not definition and startup.is_file(): definition = read(startup)
        if definition and launcher is not None:
            body = read(launcher)
            pinned = re.search(r'^env\.Item\("HERMES_HOME"\) = "(.*)"$', body, re.M)
            launched = re.search(r'^sh\.Run "(.*)", 0, False$', body, re.M)
            cmdline = launched.group(1).replace('""', '"') if launched else ''
            # An argument string built by list2cmdline. Arguments without spaces aren't quoted.
            head = re.match(r'"([^"]*)"|(\S+)', cmdline)
            exe = pathlib.Path(head.group(1) or head.group(2)) if head else None
            tail = ['-m', 'hermes_cli.main'] + (['--profile', name] if name != 'default' else []) + ['gateway', 'run']
            valid = bool(pinned) and same_path(pinned.group(1).replace('""', '"'), str(home))
            # Check the tail for a 'match', not 'contains'. If even one argument is left over, it's not our gateway.
            valid = valid and bool(head) and cmdline[head.end():].strip() == ' '.join(tail)
            valid = valid and exe is not None and same_path(exe.parent, pathlib.Path(python).parent) and exe.name.lower() in ('python.exe', 'pythonw.exe', pathlib.Path(python).name.lower())
            valid = valid and not re.search(r'API_SERVER_|GATEWAY_MULTIPLEX', body)
            # Does the registered definition launch exactly this launcher with wscript? Otherwise it's someone else's task.
            if registered.returncode == 0:
                # For task XML, look only at the exec element — upstream _build_scheduled_task_xml's <Actions><Exec>.
                # Someone else's task that writes our path in a place unrelated to execution, like <Description> or <Author>, must not pass.
                executable = re.search(r'<Command>\s*(.*?)\s*</Command>', definition, re.S | re.I)
                arguments = re.search(r'<Arguments>\s*(.*?)\s*</Arguments>', definition, re.S | re.I)
                valid = valid and executable is not None and pathlib.Path(unxml(executable.group(1))).name.lower() == 'wscript.exe'
                valid = valid and arguments is not None and launches(arguments.group(1), launcher)
            else:
                # The Startup folder fallback isn't XML. Check together the single target = "<launcher>" line written by upstream
                # _build_startup_launcher and the sh.Run wscript call that actually passes that line.
                chained = re.search(r'^target = "(.*)"$', definition, re.M)
                chain = re.search(r'^sh\.Run "(.*)", 0, False$', definition, re.M)
                chain = chain.group(1).replace('""', '"') if chain else ''
                runner = re.match(r'"([^"]*)"|(\S+)', chain)
                valid = valid and chained is not None and same_path(chained.group(1).replace('""', '"'), launcher)
                valid = valid and runner is not None and pathlib.Path(runner.group(1) or runner.group(2)).name.lower() == 'wscript.exe'
                valid = valid and runner is not None and launches(chain[runner.end():], launcher)
            if valid:
                try:
                    # get_running_pid lives in gateway.status. hermes_cli.gateway doesn't re-export it at module level.
                    from gateway.status import get_running_pid
                    pid = int(get_running_pid(home / 'gateway.pid', cleanup_stale=False) or 0)
                except Exception: pid = 0
                # A restart path exists only when there's a scheduled task; a stop and start rereads changed settings.
                # With only the Startup folder fallback there's no way to stop it, so a managed service is required.
                if registered.returncode == 0 and re.fullmatch(r'[A-Za-z0-9_-]+', task):
                    command, restart_env, stop = windows_restart(task, name, home, python)
                    warning = None
                    # PM runtime: the task keeps running the store python (upstream _gateway_run_argv), so HERMES_BIN
                    # goes where the gateway reads it at start, the Hermes .env, as on macOS. A .cmd value is ignored
                    # by Hermes on Windows, so only the launcher .exe counts.
                    if PM_RUNTIME:
                        configured = envfile(home).get('HERMES_BIN')
                        launch = 'ok' if configured and same_path(configured, LAUNCHER) else 'missing'
                else: warning = 'managed_service_required'
            else: warning = 'service_identity_mismatch'
    digest = hashlib.sha256((str(INSTALL.resolve()) + '\0' + str(home) + '\0' + service + '\0' + definition).encode()).hexdigest()
    return {'id': digest, 'service': service, 'command': command, 'env': restart_env, 'pid': pid, 'warning': warning, 'stop': stop, 'launch': launch, 'path': path if sys.platform.startswith('linux') else None}

# Checks, in a fresh process, which requirements the gateway's Python would not find. hermes_bootstrap selects the
# committed dependency tree at boot (pm/environments.py activate_dependencies) and never switches a running process,
# so this helper's own process cannot tell after an install. Stdlib only; a missing hermes_bootstrap (old installs)
# leaves the interpreter's own packages, which is what such a gateway runs with too.
DEPENDENCY_CHECK = '\n'.join([
    'import json, re, sys, importlib.metadata as metadata',
    'try:',
    '    import hermes_bootstrap',
    'except ImportError:',
    '    pass',
    'REQUIREMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\\s*(\\[[A-Za-z0-9,._ -]*\\])?\\s*((===|[<>=!~]=?)\\s*[A-Za-z0-9.*+!_-]+\\s*(,\\s*(===|[<>=!~]=?)\\s*[A-Za-z0-9.*+!_-]+\\s*)*)?(;.*)?")',
    'missing = []',
    'for requirement in json.loads(sys.argv[1]):',
    '    if not isinstance(requirement, str) or not REQUIREMENT.fullmatch(requirement.strip()): continue',
    '    name = re.match(r"[A-Za-z0-9][A-Za-z0-9._-]*", requirement.strip()).group(0)',
    '    try: metadata.version(name)',
    '    except metadata.PackageNotFoundError: missing.append(requirement)',
    'print(json.dumps(missing))',
])
def dependency_probe(deps, home):
    """The requirements among deps the gateway would not find, or None when the check itself could not run."""
    if not deps: return []
    try:
        done = subprocess.run([sys.executable, '-c', DEPENDENCY_CHECK, json.dumps(deps)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=60, cwd=str(INSTALL), env={**os.environ, 'HERMES_HOME': str(home), 'PYTHONPATH': str(INSTALL)})
        result = json.loads(done.stdout) if done.returncode == 0 else None
    except Exception: return None
    return [item for item in result if isinstance(item, str)] if isinstance(result, list) else None
def missing_dependencies(home, folder):
    """The plugin's declared python_dependencies the gateway would not find. [] when none are declared or all are
    there; None when unknown (never read as missing)."""
    if not folder: return []
    try: data = yaml.safe_load(read(home / 'plugins' / folder / 'plugin.yaml')) or {}
    except Exception: return None
    deps = data.get('python_dependencies') if isinstance(data, dict) else None
    deps = [item for item in deps if isinstance(item, str)] if isinstance(deps, list) else []
    return dependency_probe(deps, home)
def ensure_plugin_dependencies(name, home, folder, env):
    """Prepares missing plugin dependencies with Hermes's public commands, checking again after each: 'pm repair'
    rebuilds the recorded dependency tree (PM runtime), then disable and enable re-admit the plugin, which is when
    upstream installs a plugin's python_dependencies."""
    if not missing_dependencies(home, folder): return
    attempts = ([[hermes_argv('pm', 'repair')]] if PM_RUNTIME else []) + [[
        hermes_argv('--profile', name, 'plugins', 'disable', folder),
        hermes_argv('--profile', name, 'plugins', 'enable', folder),
    ]]
    for attempt in attempts:
        for argv in attempt: bounded(argv, env)
        if not missing_dependencies(home, folder): return
    fail('plugin_dependencies_missing')

def plugin_revision(folder):
    """The commit an installed git plugin is on ('hermes plugins install' keeps its .git), or None."""
    try: done = run(['git', '-c', 'safe.directory=*', '-C', str(folder), 'rev-parse', 'HEAD'], timeout=15)
    except Exception: return None
    value = done.stdout.strip() if done.returncode == 0 else ''
    return value if re.fullmatch(r'[0-9a-f]{40}', value) else None
def install_failure(output, fallback):
    """The fixed code for a failed plugin install. A blocked security scan is never bypassed."""
    diagnostic = output.decode('utf-8', errors='replace').lower()
    if 'blocked' in diagnostic and ('security' in diagnostic or 'scan' in diagnostic): return 'plugin_security_review_required'
    if 'repository not found' in diagnostic or 'could not resolve host' in diagnostic: return 'plugin_source_unavailable'
    return fallback
def update_plugin(name, home, folder, env):
    """Moves an enabled plugin to the pinned commit with public commands only, no terminal needed.
    Upstream refuses a non-interactive 'install --force' of an ENABLED plugin whose python_dependencies need
    consent ('Reinstall declined', plugins_transaction publish_plugin); a DISABLED plugin is replaced without that
    consent, and 'plugins enable' admits its dependencies without a terminal. So: disable, reinstall without
    enabling, enable. A failed step leaves the version that was there enabled again: a failed reinstall never
    replaced it, and a new version that cannot be enabled is swapped back to the recorded commit first."""
    plugins = hermes_argv('--profile', name, 'plugins')
    previous = plugin_revision(home / 'plugins' / folder)
    if bounded(plugins + ['disable', folder], env)[0]: fail('plugin_update_failed')
    code, output = bounded(plugins + ['install', SOURCE, '--ref', PIN, '--force', '--no-enable'], env)
    if code:
        bounded(plugins + ['enable', folder], env)
        fail(install_failure(output, 'plugin_update_failed'))
    code, unused = bounded(plugins + ['enable', folder], env)
    if code or not plugin(home, config(home))[1]:
        # A disabled plugin can take --no-deps; the old version's dependencies come back with enable.
        if previous: bounded(plugins + ['install', SOURCE, '--ref', previous, '--force', '--no-deps'], env)
        bounded(plugins + ['enable', folder], env)
        fail('plugin_update_failed')

def plugin(home, cfg):
    manifests = []
    versions = {}
    directory = home / 'plugins'
    if directory.is_symlink(): fail('unsafe_host_path')
    if directory.exists():
        for child in directory.iterdir():
            if child.is_symlink(): continue
            manifest = child / 'plugin.yaml'
            if manifest.is_file():
                data = yaml.safe_load(read(manifest)) or {}
                if isinstance(data, dict) and data.get('name') == 'deskrpg':
                    manifests.append(child.name)
                    installed_version = data.get('version')
                    versions[child.name] = installed_version if isinstance(installed_version, str) else None
    if len(manifests) > 1: fail('plugin_identity_ambiguous')
    plugins = mapping(cfg.get('plugins'))
    names = {'deskrpg', *manifests}
    enabled = plugins.get('enabled') or []
    disabled = plugins.get('disabled') or []
    if not isinstance(enabled, list) or not isinstance(disabled, list): fail('invalid_host_config')
    return bool(manifests), bool(names.intersection(enabled)) and not bool(names.intersection(disabled)), manifests[0] if manifests else 'deskrpg', versions.get(manifests[0]) if manifests else None

def worker_entry(cfg):
    # Only reads plugins.entries.deskrpg. None if the shape is off — doesn't block the check.
    block = cfg.get('plugins')
    entries = block.get('entries') if isinstance(block, dict) else None
    entry = entries.get('deskrpg') if isinstance(entries, dict) else None
    return entry if isinstance(entry, dict) else None
def worker_propagation(cfg, env):
    # Same rule as the plugin's propagation_enabled: config value true, or env var 1|true|yes|on.
    # The root .env is loaded into the environment when the gateway starts, so check it too.
    entry = worker_entry(cfg)
    if entry is not None and entry.get('worker_propagation') is True: return 'enabled'
    flag = env.get(WORKER_ENV)
    if isinstance(flag, str) and flag.strip().lower() in WORKER_TRUTHY: return 'enabled'
    return 'disabled'
def worker_linked():
    # Is there at least one per-profile plugins/deskrpg link made by the plugin when propagating? Folders the operator
    # installed directly in a profile aren't traces of propagation, so they're not counted.
    for child, childhome in homes():
        if child == 'default': continue
        if (childhome / 'plugins' / 'deskrpg').is_symlink(): return True
    return False

def hermes_version():
    """The installed Hermes version, or 'unknown'. Older installs carry it in pyproject.toml; upstream's PM runtime
    leaves pyproject at 0.0.0 and records the release in install-stamp.json, read through its own version_info."""
    match = re.search(r'^version\s*=\s*"([^"]+)"', read(INSTALL / 'pyproject.toml'), re.M)
    if match and match.group(1) != '0.0.0': return match.group(1)
    try:
        from hermes_cli.version_info import get_version_info
        info = get_version_info()
        derived = getattr(info, 'derived_version', None) or getattr(info, 'base_version', None)
        if isinstance(derived, str) and derived and not derived.startswith('0.0.0'): return derived
    except Exception: pass
    return 'unknown'

def candidate(name, home):
    cfg, env, token, port, external = settings(home)
    owner = identity(name, home)
    installed, enabled, plugin_name, plugin_version = plugin(home, cfg)
    version = hermes_version()
    zone = cfg.get('timezone')
    zone = zone.strip() if isinstance(zone, str) else ''
    public = {'id': owner['id'], 'label': 'Hermes ' + name, 'version': version, 'service': owner['service'], 'pluginInstalled': installed, 'pluginEnabled': enabled, 'pluginVersion': plugin_version, 'hasToken': bool(token), 'port': port, 'timezone': zone or None, 'workerPropagation': worker_propagation(cfg, env), 'workerLinked': worker_linked()}
    # A version we cannot read warns but never blocks; a version we can read and that is too low does block.
    warning = owner['warning'] or ('external_secret_provider' if external else None) or ('hermes_version_unknown' if public['version'] == 'unknown' else None)
    if warning: public['warning'] = warning
    return public, owner, cfg, token, plugin_name

def select(candidate_id):
    # The only gateway is default. Profiles are served by that gateway under /p/<name>/ —
    # there's no path to pick a profile folder as a separate gateway (it would become a candidate with no unit or port).
    item = candidate('default', ROOT)
    if item[0]['id'] == candidate_id: return 'default', ROOT, item
    fail('candidate_changed')

def port_listening(port):
    # Only check whether it opens. No key is sent — who opens it is decided by assert_port_owned in the connect step.
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.5): return True
    except OSError: return False

def gateway_state(public, owner, cfg):
    """running / stopped / profile_gateways (names of separately running profile gateways)."""
    if owner['pid'] or port_listening(public['port']): return 'running', []
    others = []
    for child, childhome in profile_names(cfg):
        if child == 'default': continue
        running = bool(identity(child, childhome)['pid'])
        if not running and (childhome / 'gateway.pid').exists():
            try:
                from gateway.status import get_running_pid
                running = bool(get_running_pid(childhome / 'gateway.pid', cleanup_stale=False))
            except Exception: running = False
        if running: others.append(child)
    return ('profile_gateways', others) if others else ('stopped', [])

def discover():
    public, owner, cfg, token, plugin_name = candidate('default', ROOT)
    state, others = gateway_state(public, owner, cfg)
    result = {**public, 'gatewayState': state, 'profiles': [n for n, h in profile_names(cfg) if n != 'default']}
    if others: result['profileGateways'] = others
    return {'candidates': [result]}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
def request(port, token, path):
    req = urllib.request.Request('http://127.0.0.1:' + str(port) + path, headers={'Authorization': 'Bearer ' + token})
    try:
        with OPENER.open(req, timeout=3) as response:
            data = response.read(65537)
            if len(data) > 65536: return 0, None
            return response.status, json.loads(data)
    except urllib.error.HTTPError as error: return error.code, None
    except Exception: return 0, None

def probe(public, token):
    if not token: return 'unknown', 'api_key_missing'
    status, body = request(public['port'], token, '/deskrpg/info')
    if status in (401,403): return 'plugin_unauthorized', 'plugin_unauthorized'
    if status == 200 and isinstance(body,dict) and body.get('plugin') == 'deskrpg' and isinstance(body.get('version'),str): return 'plugin_ready', None
    if status == 404: return 'plugin_absent', 'plugin_pending_restart' if public['pluginEnabled'] else 'plugin_disabled' if public['pluginInstalled'] else 'plugin_absent'
    return 'unknown', 'gateway_unreachable' if status == 0 else 'gateway_identity_unverified'

def foreign_listener(owner):
    """Fails for a listener that is not the service's own process. When the service itself could not be identified
    there is no process to compare against, so the listener may well be this gateway: report the identity problem
    instead of a port conflict, which would send the user to another port. No key is sent either way."""
    warning = owner.get('warning')
    fail(warning if not owner.get('pid') and warning in ('service_identity_mismatch', 'service_identity_ambiguous') else 'port_conflict')

def assert_port_owned(public, owner):
    # Never send a discovered key to an arbitrary local listener. psutil verifies PID ownership first.
    import psutil
    try:
        connections = [c for c in psutil.net_connections(kind='tcp') if c.status == psutil.CONN_LISTEN and c.laddr.port == public['port']]
    except psutil.AccessDenied:
        # macOS restricts system-wide socket enumeration; bind proves a free port, otherwise fail closed.
        connections = None
    if connections == []: return False
    if connections is None:
        # macOS allows lsof to inspect sockets owned by this login even when psutil's system scan is denied.
        listing = run(['/usr/sbin/lsof', '-nP', '-iTCP:' + str(public['port']), '-sTCP:LISTEN', '-Fp'])
        pids = [int(line[1:]) for line in listing.stdout.splitlines() if re.fullmatch(r'p[0-9]+',line)]
        if pids:
            try:
                parent = psutil.Process(owner['pid']) if owner['pid'] else None
                owned = {parent.pid, *(p.pid for p in parent.children(recursive=True))} if parent else set()
            except psutil.Error: owned = set()
            if any(pid not in owned for pid in pids): foreign_listener(owner)
            return True
        try:
            sock = socket.socket(); sock.bind(('127.0.0.1', public['port'])); sock.close(); return False
        except OSError: fail('listener_ownership_unverified')
    owned = set()
    if owner['pid']:
        try:
            process = psutil.Process(owner['pid'])
            owned = {process.pid, *(p.pid for p in process.children(recursive=True))}
        except psutil.Error: pass
    if not connections or any(c.pid not in owned for c in connections): foreign_listener(owner)
    return True

def port_free(port):
    # Never touch someone else's listener. Only check whether it binds, then close immediately.
    sock = socket.socket()
    try:
        sock.bind(('127.0.0.1', port))
        return True
    except OSError: return False
    finally: sock.close()
def suggest_port(current):
    # Pick the smallest free port, avoiding ports used by other profiles in this home and ports currently open.
    # None if none can be picked — only the error goes out, without a suggestion, and the flow is unchanged.
    used = {current}
    for unused_name, childhome in homes():
        try: used.add(settings(childhome)[3])
        except Exception: pass
    for port in range(PORT_MIN, PORT_MAX + 1):
        if port not in used and port_free(port): return port
    return None

def allowlist(cfg):
    gateway = mapping(cfg.get('gateway'))
    allow = cfg.get('multiplex_profile_allowlist', gateway.get('multiplex_profile_allowlist'))
    if allow is not None and (not isinstance(allow,list) or any(not isinstance(n,str) or not NAME.fullmatch(n) for n in allow)): fail('invalid_host_config')
    return allow
def profile_names(cfg):
    allow = allowlist(cfg)
    return [(name,home) for name,home in homes() if name == 'default' or allow is None or name in allow]

def needs_service(owner):
    # This is the only rule for recognizing a host without a unit. Don't decide by service name —
    # the Linux branch fills in the name 'hermes-gateway.service' first even without a unit file,
    # so service == 'manual' is true only on macOS (measured: the register step was skipped entirely on a fresh install).
    # identity_mismatch/ambiguous means someone else's unit or a hand-edited unit, so don't overwrite it.
    return not owner['command'] and owner['warning'] == 'managed_service_required'

def service_failure(owner):
    # On Windows, upstream falls back to a Startup-folder entry when it cannot register the scheduled
    # task, and that entry can be neither stopped nor restarted. Name the missing scheduled task so the
    # screen can point at Task Scheduler instead of a generic "no managed service".
    if owner['warning'] == 'managed_service_required' and sys.platform == 'win32':
        return 'windows_scheduled_task_missing'
    return owner['warning'] or 'managed_service_required'

def preflight(name, home, item, service_planned=False):
    public, owner, cfg, token, plugin_name = item
    if version_below(public['version'], HERMES_MIN): fail('hermes_version_unsupported')
    # Inspect plans installing_service for a host without a unit, and that stage runs before prepare re-checks
    # here — so a missing unit is not a reason to block the review (a fresh install always lacks one).
    if not owner['command'] and not (service_planned and needs_service(owner)): fail(service_failure(owner))
    if settings(home)[4]:
        listening = assert_port_owned(public,owner)
        code, models = request(public['port'],token,'/v1/models') if token and listening else (0,None)
        if code != 200 or not isinstance(models,dict) or not isinstance(models.get('data'),list): fail('external_secret_provider')
    if token and (len(token) < 16 or '\n' in token or '\r' in token): fail('api_key_invalid')
    gateway = mapping(cfg.get('gateway'))
    env = envfile(home)
    if 'GATEWAY_MULTIPLEX_PROFILES' in env: fail('multiplex_override_present')
    multiplex = cfg.get('multiplex_profiles', gateway.get('multiplex_profiles', False))
    if name != 'default':
        if multiplex: fail('listener_owner_required')
        assert_port_owned(public,owner)
        return
    if not multiplex or not owner['pid']:
        for child, childhome in profile_names(cfg):
            if child == 'default': continue
            other = identity(child, childhome)
            if other['pid']: fail('multiplex_conflict')
            # Also catch unmanaged profile processes; PID files alone are never treated as service ownership.
            if (childhome / 'gateway.pid').exists():
                from gateway.status import get_running_pid
                if get_running_pid(childhome / 'gateway.pid', cleanup_stale=False): fail('multiplex_conflict')
    assert_port_owned(public, owner)

def atomic(path, content):
    read(path)
    mode = (path.stat().st_mode & 0o777) if path.exists() else 0o600
    fd, tmp = tempfile.mkstemp(prefix='.deskrpg-setup-', dir=str(path.parent))
    try:
        os.fchmod(fd, mode & 0o600)
        with os.fdopen(fd,'w',encoding='utf-8') as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def bounded(argv, env):
    # Keep diagnostics in bounded memory only. Never return them or persist them in jobs.
    # Windows doesn't support pass_fds. The parent keeps holding the lock and doesn't hand it down.
    # On the normal path the protection scope is the same — the parent always outlives the child. If the parent exits
    # abnormally, Windows closes the handle and the lock is released immediately (on POSIX the child keeps holding the fd).
    extra = {} if WINDOWS else {'pass_fds': (LOCK.fileno(),)}
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=str(INSTALL), **extra)
    try:
        output = child.stdout.read(262145)
        if len(output) > 262144:
            child.kill()
            child.wait()
            fail('output_limit')
        code = child.wait()
    finally:
        child.stdout.close()
    return code, output

def set_worker_launch(name, home):
    """The set-worker-launch action (PM runtime): point HERMES_BIN at the launcher so kanban workers can start.
    Reads the service again: install-service may have just written it."""
    if not (PM_RUNTIME and (sys.platform.startswith('linux') or sys.platform in ('darwin', 'win32'))): fail('invalid_host_operation')
    owner = identity(name, home)
    if not owner['command'] or owner['launch'] is None: fail(service_failure(owner))
    if owner['launch'] == 'ok': return {'ok': True, 'changed': False}
    if sys.platform in ('darwin', 'win32'):
        # Windows: the scheduled task's .vbs is regenerated by 'hermes gateway install', so the .env is the one place
        # that survives. macOS — not in the plist: Hermes rewrites it whenever it differs from what it generates, which is on every
        # 'hermes gateway start' and 'restart' (refresh_launchd_plist_if_needed; measured: an added HERMES_BIN was
        # gone after one restart). Hermes's own 'config set' stores an UPPER_SNAKE name in <home>/.env, which the
        # gateway loads into its environment at start. The restart step applies it.
        if bounded(hermes_argv('--profile', name, 'config', 'set', 'HERMES_BIN', str(LAUNCHER)), {**os.environ, 'HERMES_HOME': str(home)})[0]:
            fail('worker_launch_write_failed')
        if identity(name, home)['launch'] != 'ok': fail('worker_launch_write_failed')
        return {'ok': True, 'changed': True}
    folder = owner['path'].parent / (owner['service'] + '.d')
    if folder.is_symlink() or (folder.exists() and not folder.is_dir()): fail('unsafe_host_path')
    folder.mkdir(mode=0o755, exist_ok=True)
    try: atomic(folder / WORKER_LAUNCH_DROPIN, worker_launch_dropin_text())
    except Failure: raise
    except Exception: fail('worker_launch_write_failed')
    if run(['systemctl', '--user', 'daemon-reload'], timeout=30).returncode: fail('worker_launch_write_failed')
    # The restart step makes the gateway run with it; here only confirm systemd sees exactly our value.
    if identity(name, home)['launch'] != 'ok': fail('worker_launch_write_failed')
    return {'ok': True, 'changed': True}

def main(action, candidate_id=None, option=None):
    global LOCK
    if ROOT.is_symlink(): fail('unsafe_host_path')
    if action in ('install','configure','restart','install-service','set-timezone','set-port','create-profile','provision-key','set-worker-propagation','set-worker-launch'):
        # A host-wide advisory lock also protects against a retry from a restarted DeskRPG server.
        # Keep it inherited by the installer until the entire bounded action exits.
        lock_path = ROOT / '.deskrpg-setup.lock'
        if WINDOWS:
            # No O_NOFOLLOW. Path.is_symlink() doesn't catch Windows junctions (CPython's os.stat doesn't
            # report junctions as symlinks) — check the reparse point bit directly. Pass if the file doesn't exist yet.
            try:
                attrs = getattr(os.stat(lock_path, follow_symlinks=False), 'st_file_attributes', 0)
            except FileNotFoundError:
                attrs = 0
            if attrs & stat.FILE_ATTRIBUTE_REPARSE_POINT: fail('unsafe_host_path')
            import msvcrt
            fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
            # os.open follows reparse points (symlinks/junctions) and opens a handle to the target file — that handle's fstat
            # doesn't report the reparse bit, so if the path was swapped between the check above and this open, this
            # recheck can't catch it. It doesn't close the TOCTOU window; it only defends the rare remaining case (where the
            # handle still points at the reparse point itself).
            if getattr(os.fstat(fd), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                os.close(fd)
                fail('unsafe_host_path')
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            except OSError:
                os.close(fd)
                fail('host_busy')
        else:
            import fcntl
            fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                fail('host_busy')
        LOCK = os.fdopen(fd,'w')
    if action == 'discover':
        return discover()
    name, home, item = select(candidate_id)
    public, owner, cfg, token, plugin_name = item
    if action == 'check-model':
        # Only check whether credentials exist. No result fails the setup — if ambiguous, it's unknown.
        return {'ok': True, 'model': model_state(cfg, home)}
    if action == 'set-port':
        # Only ports the operator explicitly accepted on screen get here. Ownership judgment is left alone —
        # only this profile's .env is edited, and the following restart step actually applies it.
        try: value = int(option) if isinstance(option, str) and option.strip() else 0
        except (ValueError, TypeError): fail('invalid_host_operation')
        if not 1024 <= value <= 65535: fail('invalid_host_operation')
        old = read(home / '.env')
        kept = [line for line in old.splitlines() if not re.match(r'^\s*(export\s+)?API_SERVER_PORT\s*=', line)]
        body = '\n'.join(kept).rstrip('\n')
        try: atomic(home / '.env', (body + '\n' if body else '') + 'API_SERVER_PORT=' + str(value) + '\n')
        except Failure: raise
        except Exception: fail('port_write_failed')
        if settings(home)[3] != value: fail('port_write_failed')
        return {'ok': True, 'port': value}
    if action == 'inspect':
        try: listening = assert_port_owned(public, owner)
        except Failure as conflict:
            # Add one alternative only on conflict. If none can be picked, only the error goes out.
            if str(conflict) == 'port_conflict':
                suggestion = suggest_port(public['port'])
                if suggestion is not None: conflict.suggestion = suggestion
            raise
        status, warning = probe(public,token) if listening else ('unknown','gateway_unreachable')
        # A missing unit is what the planned installing_service stage fixes, not a reason to stop the review.
        if public.get('warning') == 'managed_service_required' and needs_service(owner): public.pop('warning', None)
        if warning and 'warning' not in public: public['warning'] = warning
        preparation_safe = False
        try:
            preflight(name,home,item,service_planned=True)
            preparation_safe = True
            if public.get('warning') == 'external_secret_provider':
                public.pop('warning',None)
                if warning: public['warning'] = warning
        except Failure as error: public['warning'] = str(error)
        changes = []
        if needs_service(owner): changes.append('installing_service')
        # PM runtime on systemd or launchd: kanban workers need HERMES_BIN — missing on a service upstream just wrote or
        # will write.
        if PM_RUNTIME and (sys.platform.startswith('linux') or sys.platform in ('darwin', 'win32')) and (owner['launch'] == 'missing' or needs_service(owner)):
            changes.append('setting_worker_launch')
        if not public['pluginInstalled']: changes.append('installing_plugin')
        elif version_below(public['pluginVersion'], PLUGIN_VERSION): changes.append('updating_plugin')
        elif not public['pluginEnabled']: changes.append('enabling_plugin')
        elif missing_dependencies(home, plugin(home, cfg)[2]): changes.append('enabling_plugin')
        gateway = mapping(cfg.get('gateway'))
        # A replaced plugin or a freshly registered unit only takes effect after the gateway restarts.
        if status != 'plugin_ready' or (name == 'default' and not cfg.get('multiplex_profiles',gateway.get('multiplex_profiles',False))) or 'updating_plugin' in changes or 'enabling_plugin' in changes or 'installing_service' in changes or 'setting_worker_launch' in changes:
            changes.extend(['configuring_api','restarting_gateway','verifying_gateway'])
        available = profile_names(cfg) if name == 'default' else [(name,home)]
        profiles = []
        for child,childhome in available:
            child_settings = settings(childhome)
            metadata = {'name':child, 'hasToken':bool(child_settings[2])}
            # Also fill sibling profiles: they can be issued a key if they have none and don't use an external secret provider.
            if preparation_safe and not child_settings[2] and not child_settings[4]:
                metadata['canProvision'] = True
            profiles.append(metadata)
        return {'candidate': public, 'pluginStatus': status, 'changes': changes, 'profiles':profiles}
    if action == 'install-service':
        # A host without a unit can never pass preflight's managed-service gate, so the rescue runs
        # before it. Hermes writes the unit itself — DeskRPG never authors one, because only a
        # Hermes-authored unit can pass the identity check that authorizes a restart later.
        if version_below(public['version'], HERMES_MIN): fail('hermes_version_unsupported')
        if not needs_service(owner): return {'ok': True}
        assert_port_owned(public, owner)
        env = {**os.environ, 'HERMES_HOME': str(home)}
        code, output = bounded(hermes_argv('--profile', name, 'gateway', 'install'), env)
        if code:
            # Upstream refuses a user-scope unit inside a container (hermes_cli/gateway.py
            # refuses_container_user_scope_install). Only the code leaves this process, never the output.
            if b'inside a container' in output: fail('service_container_refused')
            fail('service_install_failed')
        fresh = identity(name, home)
        if needs_service(fresh): fail('windows_scheduled_task_missing' if sys.platform == 'win32' else 'service_install_failed')
        # The candidate id includes a hash of the service definition. We just created the unit, so the id changed —
        # without returning the new id, every following step dies with candidate_changed (measured).
        return {'ok': True, 'candidateId': fresh['id']}
    if action == 'create-profile':
        # Only the listener owner (default) adds profiles.
        if name != 'default': fail('profile_provision_forbidden')
        if version_below(public['version'], HERMES_MIN): fail('hermes_version_unsupported')
        try: request_body = json.loads(option) if isinstance(option, str) and option else None
        except Exception: fail('profile_name_invalid')
        if not isinstance(request_body, dict): fail('profile_name_invalid')
        new_name = request_body.get('name')
        description = request_body.get('description')
        if not isinstance(new_name, str) or not NAME.fullmatch(new_name) or new_name in RESERVED_PROFILE: fail('profile_name_invalid')
        if description is not None and (not isinstance(description, str) or len(description) > 200 or re.search(r'[\r\n\x00]', description)): fail('profile_name_invalid')
        if (ROOT / 'profiles').is_symlink(): fail('unsafe_host_path')
        target = ROOT / 'profiles' / new_name
        if target.exists() or target.is_symlink() or any(child == new_name for child,_ in homes()): fail('profile_exists')
        if bounded(hermes_argv('profile', 'create', new_name, *(['--description', description] if description else [])), {**os.environ, 'HERMES_HOME': str(ROOT)})[0]:
            fail('profile_create_failed')
        # Even if the command exits 0, check directly that it appeared on disk.
        if not target.is_dir() or target.is_symlink(): fail('profile_create_failed')
        allowed = allowlist(config(home))
        result = {'ok': True, 'profile': new_name}
        # The allowlist belongs to the operator — don't fix it, only report that it isn't served.
        if isinstance(allowed, list) and new_name not in allowed: result['warning'] = 'profile_not_served'
        return result
    if action == 'provision-key':
        target_name = option if isinstance(option, str) else ''
        if not target_name or not NAME.fullmatch(target_name) or target_name in RESERVED_PROFILE: fail('profile_name_invalid')
        if name != 'default': fail('profile_provision_forbidden')
        target_home = next((h for child,h in homes() if child == target_name), None)
        if target_home is None: fail('candidate_changed')
        child_token, child_external = settings(target_home)[2], settings(target_home)[4]
        # Profiles using an external secret provider keep their provider settings untouched.
        if child_external: fail('profile_provision_forbidden')
        if child_token:
            if len(child_token) < 16 or '\n' in child_token or '\r' in child_token: fail('api_key_invalid')
            # If it already exists, don't rotate. Do nothing and succeed.
            return {'ok': True, 'provisioned': False, 'profile': target_name}
        old = read(target_home / '.env')
        try: atomic(target_home / '.env', old.rstrip('\n') + '\nAPI_SERVER_KEY=' + secrets.token_hex(32) + '\n')
        except Failure: raise
        except Exception: fail('profile_key_failed')
        if not settings(target_home)[2]: fail('profile_key_failed')
        return {'ok': True, 'provisioned': True, 'profile': target_name}
    preflight(name,home,item)
    if action == 'install':
        env = {**os.environ, 'HERMES_HOME': str(home)}
        argv = hermes_argv('--profile', name, 'plugins')
        updating = False
        if not public['pluginInstalled']: argv += ['install', SOURCE, '--ref', PIN, '--enable']
        elif version_below(public['pluginVersion'], PLUGIN_VERSION):
            # Disable, reinstall the pinned ref with --force, enable (update_plugin). --force is not a scan bypass:
            # a blocked security scan still fails with plugin_security_review_required.
            updating = True
            update_plugin(name, home, plugin_name, env)
            argv = None
        elif not public['pluginEnabled']: argv += ['enable', plugin_name]
        # Installed, enabled and current: only its dependencies may still need preparing (below).
        else: argv = None
        code, output = bounded(argv, env) if argv else (0, b'')
        failure_code = 'plugin_update_failed' if updating else 'plugin_install_failed'
        if code: fail(install_failure(output, failure_code))
        installed, enabled, installed_name, installed_version = plugin(home,config(home))
        if installed and not enabled and installed_name:
            # Upstream's installer asks consent for a plugin's Python dependencies and, with nobody to answer
            # (no terminal), leaves the plugin installed but disabled; enabling it prepares those dependencies.
            code, output = bounded(hermes_argv('--profile', name, 'plugins', 'enable', installed_name), env)
            if code: fail(failure_code)
            installed, enabled, installed_name, installed_version = plugin(home,config(home))
        if not installed or not enabled: fail(failure_code)
        if updating and version_below(installed_version, PLUGIN_VERSION): fail('plugin_update_failed')
        ensure_plugin_dependencies(name, home, installed_name, env)
        if not plugin(home,config(home))[1]: fail(failure_code)
    elif action == 'set-timezone':
        value = option if isinstance(option, str) else ''
        if not value or len(value) > 64 or not TIMEZONE.fullmatch(value): fail('timezone_invalid')
        # By shape alone 'Asia/../Seoul' passes — don't leave a value zoneinfo would reject in the config.
        if any(part in ('.','..') for part in value.split('/')): fail('timezone_invalid')
        fresh = config(home)
        existing = fresh.get('timezone')
        # Only ever fill an empty slot. An operator's own timezone is never overwritten.
        if isinstance(existing, str) and existing.strip(): return {'ok': True}
        if existing is not None and not isinstance(existing, str): fail('invalid_host_config')
        fresh['timezone'] = value
        try: atomic(home / 'config.yaml', yaml.safe_dump(fresh, sort_keys=False, allow_unicode=True))
        except Failure: raise
        except Exception: fail('timezone_write_failed')
        if config(home).get('timezone') != value: fail('timezone_write_failed')
    elif action == 'set-worker-launch':
        return set_worker_launch(name, home)
    elif action == 'set-worker-propagation':
        # Only values the operator picked on screen get here. Change only this one key in the root config and leave the rest.
        if option not in ('true', 'false'): fail('invalid_host_operation')
        desired = option == 'true'
        fresh = config(home)
        # A mismatched shape (list/string) belongs to the operator — reject rather than overwrite.
        block = mapping(fresh.get('plugins'))
        entries = mapping(block.get('entries'))
        entry = mapping(entries.get('deskrpg'))
        if entry.get('worker_propagation') is not desired:
            entry['worker_propagation'] = desired
            entries['deskrpg'] = entry
            block['entries'] = entries
            fresh['plugins'] = block
            try: atomic(home / 'config.yaml', yaml.safe_dump(fresh, sort_keys=False, allow_unicode=True))
            except Failure: raise
            except Exception: fail('worker_propagation_write_failed')
            stored = worker_entry(config(home))
            if stored is None or stored.get('worker_propagation') is not desired: fail('worker_propagation_write_failed')
        # Return the actual state — even after writing off, it's still enabled if the .env variable turns it on.
        return {'ok': True, 'propagation': worker_propagation(config(home), envfile(home))}
    elif action == 'configure':
        # Preserve existing config shapes while setting the effective merged API block.
        # If the gateway key exists but its value is empty, setdefault returns None — a freshly installed
        # Hermes's config.yaml has exactly that shape, so it died here with a TypeError (measured).
        gateway_block = mapping(cfg.get('gateway'))
        cfg['gateway'] = gateway_block
        if name == 'default':
            gateway_block['multiplex_profiles'] = True
            if 'multiplex_profiles' in cfg: cfg['multiplex_profiles'] = True
        api = mapping(gateway_block.get('api_server'))
        api['enabled'] = True
        gateway_block['api_server'] = api
        atomic(home / 'config.yaml', yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True))
        if not token:
            old = read(home / '.env')
            # Empty assignment is absent; append wins in Hermes's canonical parser.
            atomic(home / '.env', old.rstrip('\n') + '\nAPI_SERVER_KEY=' + secrets.token_hex(32) + '\n')
    elif action == 'restart':
        # Past the limit, report with a code that carries the cause — if not caught, the top-level except mashes it into host_operation_failed.
        # env only when the restart plan pins one (Windows CLI restart); otherwise the helper's own environment.
        extra = {'env': owner['env']} if owner.get('env') else {}
        try: code = run(owner['command'], timeout=restart_timeout(owner), **extra).returncode
        except subprocess.TimeoutExpired: fail('gateway_restart_failed')
        if code: fail('gateway_restart_failed')
    elif action == 'verify':
        ready = False
        for attempt in range(20):
            public, owner, cfg, token, plugin_name = select(candidate_id)[2]
            if assert_port_owned(public,owner) and probe(public,token)[0] == 'plugin_ready':
                ready = True; break
            time.sleep(1)
        if not ready: fail('gateway_verification_failed')
        code, live = request(public['port'],token,'/deskrpg/profiles')
        if code != 200 or not isinstance(live,dict) or not isinstance(live.get('profiles'),list): fail('profile_verification_failed')
        names = {p.get('name') for p in live['profiles'] if isinstance(p,dict) and isinstance(p.get('name'),str)}
        profiles = []
        warnings = []
        selected_profiles = profile_names(cfg) if name == 'default' else [(name,home)]
        for child, childhome in selected_profiles:
            if child not in names: continue
            _, _, childtoken, _, external = settings(childhome)
            if not childtoken: continue
            path = '/v1/models' if child == 'default' else '/p/' + child + '/v1/models'
            code, models = request(public['port'],childtoken,path)
            if code == 200 and isinstance(models,dict) and isinstance(models.get('data'),list):
                profiles.append({'name':child,'token':childtoken})
                # Install doesn't create model credentials. An empty list isn't a failure but something for a person to do.
                if child == name and not models['data'] and 'model_provider_required' not in warnings: warnings.append('model_provider_required')
        return {'prepared': {'baseUrl':'http://127.0.0.1:' + str(public['port']), 'token':token, 'profiles':profiles}, 'warnings': warnings}
    else: fail('invalid_host_operation')
    return {'ok':True}

def entry(action, candidate_id, option=None):
    try: print(json.dumps(main(action,candidate_id,option)))
    except Failure as error:
        body = {'error': str(error)}
        suggestion = getattr(error, 'suggestion', None)
        # Only one code and one number. None of the host's raw text goes in here.
        if isinstance(suggestion, int) and not isinstance(suggestion, bool): body['suggestedPort'] = suggestion
        print(json.dumps(body))
    except Exception: print(json.dumps({'error':'host_operation_failed'}))
`;
