/**
 * Gathers platform-dependent queries in one place. All are pure functions that take `platform` as an argument —
 * tests running on a Mac must be able to walk the win32 paths as-is.
 */
import path from "node:path";

/** Default extensions for Windows when PATHEXT is empty. Only the executable ones of cmd.exe's defaults are kept. */
export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export function isWindows(platform: string): boolean {
  return platform === "win32";
}

/** The path meaning "read nothing" in ssh config. Windows has no `/dev/null`. */
export function nullDevicePath(platform: string): string {
  return isWindows(platform) ? "NUL" : "/dev/null";
}

/**
 * Is the command on PATH.
 *
 * Measured on Windows (WinServer, 2026-09-20): the binary is `ssh.exe`, so looking it up without an extension always
 * fails.
 * `hasCommand(ssh)=false` / `hasCommand(ssh.exe)=true`, and that is why SSH mode disappeared from the screen.
 */
export function hasCommandIn(
  command: string,
  env: { PATH?: string; PATHEXT?: string },
  platform: string,
  access: (candidate: string) => boolean,
): boolean {
  const pathDelimiter = isWindows(platform) ? ";" : ":";
  const separator = isWindows(platform) ? "\\" : "/";
  const directories = (env.PATH ?? "").split(pathDelimiter).filter(Boolean);
  // Check the extensionless name first — for non-win32 this is all there is.
  const suffixes = [""];
  if (isWindows(platform)) {
    for (const raw of (env.PATHEXT || DEFAULT_PATHEXT).split(";")) {
      const suffix = raw.trim();
      if (suffix) {
        // Try the lowercase version first
        suffixes.push(suffix.toLowerCase());
        // Additionally try the casing that differs from the original
        if (suffix !== suffix.toLowerCase()) {
          suffixes.push(suffix);
        }
      }
    }
  }
  return directories.some((directory) =>
    suffixes.some((suffix) => {
      try {
        const trailing = directory.endsWith(separator) ? "" : separator;
        const candidate = directory + trailing + command + suffix;
        return access(candidate);
      } catch {
        return false;
      }
    }),
  );
}

/**
 * Hermes home. Same decision as upstream `_get_platform_default_hermes_home()` in `hermes_constants.py`.
 * Windows is `%LOCALAPPDATA%\hermes`, everything else is `~/.hermes`. This rule also appears in the same shape in the
 * Python bodies running on the host (HOST_BOOTSTRAP·HOST_INSTALLER·HOST_HELPER) and the PowerShell launcher
 * — fix one place and fix the rest along with it.
 */
export function hermesRootPath(
  platform: string,
  env: { LOCALAPPDATA?: string },
  home: string,
): string {
  if (!isWindows(platform)) return path.join(home, ".hermes");
  const base = (env.LOCALAPPDATA ?? "").trim() || path.join(home, "AppData", "Local");
  return path.join(base, "hermes");
}

/** Where python lives inside a venv. On Windows it is `Scripts\python.exe` (upstream gateway_windows.py:1457,1475). */
export function venvPythonPath(platform: string, venvDir: string): string {
  return isWindows(platform)
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}
