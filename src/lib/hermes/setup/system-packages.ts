/**
 * System packages Hermes install needs but that can't be installed without sudo — curl, git, C++ compiler.
 *
 * The Hermes install script (install.sh) fetches Python, uv and Node into the user's home itself, but tries to
 * install git and a C++ compiler via the package manager (`check_git`, `check_cxx_compiler`; with `set -e` it stops
 * if they're missing). As root or with passwordless sudo it installs them itself; otherwise we stop early here and
 * show the admin a one-line command.
 * DeskRPG does not take sudo passwords.
 *
 * The job keeps only codes (`curl`, `git`, `cxx`) and the package manager name. The command string is built by the
 * screen from this table.
 * The client imports this too — no node modules are used.
 */
export const SYSTEM_PACKAGES = ["curl", "git", "cxx"] as const;
export type SystemPackage = (typeof SYSTEM_PACKAGES)[number];
export type PackageManager = "apt" | "dnf" | "pacman" | "macos";

const MANAGERS: Record<string, PackageManager> = {
  debian: "apt",
  ubuntu: "apt",
  linuxmint: "apt",
  pop: "apt",
  raspbian: "apt",
  fedora: "dnf",
  rhel: "dnf",
  centos: "dnf",
  rocky: "dnf",
  almalinux: "dnf",
  amzn: "dnf",
  arch: "pacman",
  manjaro: "pacman",
  endeavouros: "pacman",
  macos: "macos",
};

/** ID from `/etc/os-release` ("macos" for macOS) → package manager. null for unknown distros. */
export function packageManagerFor(distro: unknown): PackageManager | null {
  return typeof distro === "string" ? (MANAGERS[distro] ?? null) : null;
}

export function parseSystemPackages(value: unknown): SystemPackage[] {
  const words = typeof value === "string" ? value.trim().split(/\s+/) : [];
  return SYSTEM_PACKAGES.filter((p) => words.includes(p));
}

const NAMES: Record<Exclude<PackageManager, "macos">, Record<SystemPackage, string>> = {
  apt: { curl: "curl", git: "git", cxx: "build-essential" },
  dnf: { curl: "curl", git: "git", cxx: "gcc-c++" },
  pacman: { curl: "curl", git: "git", cxx: "base-devel" },
};

/** Command the admin runs once on the target server. null for unknown distros (the screen shows only package
 * names). */
export function systemPackagesCommand(
  manager: PackageManager | null,
  packages: readonly SystemPackage[],
): string | null {
  if (!manager || !packages.length) return null;
  // On macOS the Command Line Tools provide both git and clang. curl is there by default.
  if (manager === "macos") return "xcode-select --install";
  const names = packages.map((p) => NAMES[manager][p]).join(" ");
  if (manager === "apt") return `sudo apt-get update && sudo apt-get install -y ${names}`;
  if (manager === "dnf") return `sudo dnf install -y ${names}`;
  return `sudo pacman -S --needed ${names}`;
}
