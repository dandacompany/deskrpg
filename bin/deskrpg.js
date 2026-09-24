#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn, execSync } = require("node:child_process");
const readline = require("node:readline");

const EXTERNAL_ALIAS_PACKAGE_MAP = new Map([
  ["better-sqlite3-", "better-sqlite3"],
  ["pg-", "pg"],
]);

function getPackageRoot() {
  return path.resolve(__dirname, "..");
}

function loadRuntimePathsModule() {
  return require(path.join(getPackageRoot(), "src", "lib", "runtime-paths.js"));
}

// Lazy-load with the same rule as runtime-paths. Requiring `../src/...` at the top level would
// (1) tie commands that do not need that file (init, doctor, …) to it, and
// (2) assume the package root is relative to __dirname — which is why getPackageRoot() exists.
function loadCliPasswordModule() {
  return require(path.join(getPackageRoot(), "src", "lib", "cli-password.js"));
}

function loadCliMessagesModule() {
  return require(path.join(getPackageRoot(), "src", "lib", "cli-messages.js"));
}

/** A terminal message in the terminal's language (`ko*` locale → Korean, otherwise English). */
function msg(key, params) {
  return loadCliMessagesModule().cliMessage(key, params);
}

function loadCliResetPasswordModule() {
  return require(path.join(getPackageRoot(), "src", "lib", "cli-reset-password.js"));
}

function getInstalledPackageRoot(packageName) {
  const packageJsonPath = require.resolve(path.join(packageName, "package.json"), {
    paths: [getPackageRoot(), process.cwd()],
  });
  return path.dirname(packageJsonPath);
}

function getTsxLoaderPath() {
  return require.resolve("tsx", {
    paths: [getPackageRoot(), process.cwd()],
  });
}

function findStandaloneAppRoot() {
  const packageRoot = getPackageRoot();
  const standaloneRoot = path.join(packageRoot, ".next", "standalone");

  if (!fs.existsSync(standaloneRoot)) {
    return null;
  }

  const queue = [standaloneRoot];
  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) continue;

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.name === "node_modules") {
        continue;
      }

      const entryPath = path.join(currentDir, entry.name);
      if (entry.isFile() && entry.name === "server.js") {
        return currentDir;
      }

      if (entry.isDirectory()) {
        queue.push(entryPath);
      }
    }
  }

  return null;
}

function removeExistingPath(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    }
    fs.rmSync(targetPath, { force: true, recursive: true });
  } catch {
    // Ignore cleanup failures and let the subsequent write surface the error.
  }
}

function ensureLinkedRuntimePath(targetPath, sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  const parentDir = path.dirname(targetPath);
  fs.mkdirSync(parentDir, { recursive: true });
  removeExistingPath(targetPath);

  try {
    const sourceStat = fs.lstatSync(sourcePath);
    const symlinkType =
      process.platform === "win32"
        ? sourceStat.isDirectory()
          ? "junction"
          : "file"
        : sourceStat.isDirectory()
          ? "dir"
          : "file";

    fs.symlinkSync(sourcePath, targetPath, symlinkType);
  } catch {
    fs.cpSync(sourcePath, targetPath, { recursive: true });
  }
}

function collectExternalModuleAliases(runtimeRoot) {
  const chunkDir = path.join(runtimeRoot, ".next", "server", "chunks");
  if (!fs.existsSync(chunkDir)) {
    return [];
  }

  const aliases = new Map();
  const entries = fs.readdirSync(chunkDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }

    const chunkText = fs.readFileSync(path.join(chunkDir, entry.name), "utf8");
    const matches = chunkText.matchAll(/require\("([^"]+)"\)/g);
    for (const match of matches) {
      const aliasName = match[1];
      for (const [prefix, packageName] of EXTERNAL_ALIAS_PACKAGE_MAP.entries()) {
        if (aliasName.startsWith(prefix)) {
          aliases.set(aliasName, packageName);
        }
      }
    }
  }

  return [...aliases.entries()];
}

function ensureExternalModuleAliases(runtimeRoot) {
  const aliasDir = path.join(runtimeRoot, ".next", "node_modules");
  const aliases = collectExternalModuleAliases(runtimeRoot);

  for (const [aliasName, packageName] of aliases) {
    let sourcePath;
    try {
      sourcePath = getInstalledPackageRoot(packageName);
    } catch {
      continue;
    }

    ensureLinkedRuntimePath(path.join(aliasDir, aliasName), sourcePath);
  }
}

function prepareStandaloneRuntime() {
  const packageRoot = getPackageRoot();
  const standaloneAppRoot = findStandaloneAppRoot();

  if (!standaloneAppRoot) {
    return null;
  }

  ensureLinkedRuntimePath(path.join(standaloneAppRoot, "public"), path.join(packageRoot, "public"));
  ensureLinkedRuntimePath(
    path.join(standaloneAppRoot, ".next", "static"),
    path.join(packageRoot, ".next", "static"),
  );
  ensureExternalModuleAliases(packageRoot);
  ensureExternalModuleAliases(standaloneAppRoot);

  return standaloneAppRoot;
}

function loadEnvFile(envPath) {
  const envLoader = process.loadEnvFile;
  if (typeof envLoader === "function") {
    envLoader(envPath);
    return;
  }

  if (!fs.existsSync(envPath)) return;

  const envText = fs.readFileSync(envPath, "utf8");
  for (const line of envText.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) continue;
    process.env[key] = value;
  }
}

function getVersion() {
  return require(path.join(getPackageRoot(), "package.json")).version;
}

function printHelp() {
  const version = getVersion();
  console.log(`deskrpg v${version} — Virtual Office RPG Platform\n`);
  console.log("Usage: deskrpg <command>\n");
  console.log("Commands:");
  console.log("  init                  Initialize DeskRPG runtime (~/.deskrpg)");
  console.log("  start [-p PORT] [-d]  Start the DeskRPG server");
  console.log("  stop                  Stop the running DeskRPG server");
  console.log("  create-user           Create a new user account");
  console.log("  reset-password <ID>   Issue a temporary password for a login ID");
  console.log("  update                Update to the latest version");
  console.log("  host-setup <on|off|status>  Toggle the connection wizard's host setup");
  console.log("  doctor                Check runtime health");
  console.log("  remove                Remove runtime data (~/.deskrpg)");
  console.log("  uninstall             Remove runtime data and uninstall the package");
  console.log("  version, -v           Show current version");
  console.log("  help, -h              Show this help message");
  console.log("");
  console.log("Options:");
  console.log("  -p, --port PORT       Set server port (default: 3000)");
  console.log("  -d, --daemon          Run server in background");
  console.log("");
  console.log("create-user options:");
  console.log("  --login-id ID         Login ID (required)");
  console.log("  --nickname NAME       Display name (required)");
  console.log("  --password PW         Password (8+ chars). Beware: stays in shell history");
  console.log("  --password-stdin      Read the password from stdin instead");
  console.log("  --role ROLE           User role: admin or user (default: user)");
  console.log("");
  console.log("reset-password:");
  console.log("  deskrpg reset-password alice   # prints a one-time temporary password");
  console.log("  The user must change it at the next login.");
  console.log("");
  console.log("Examples:");
  console.log("  deskrpg init          # First-time setup");
  console.log("  deskrpg start         # Start on default port 3000");
  console.log("  deskrpg start -p 8080 # Start on port 8080");
  console.log("  deskrpg start -d      # Start in background");
  console.log("  deskrpg stop          # Stop background server");
  console.log(
    "  deskrpg create-user --login-id alice --nickname Alice   # prompts for the password",
  );
  console.log(
    '  echo "$PW" | deskrpg create-user --login-id alice --nickname Alice --password-stdin',
  );
}

function printUsage() {
  console.error(
    "Usage: deskrpg <init|start|stop|create-user|reset-password|update|host-setup|doctor|remove|uninstall|version|help>",
  );
}

function initializeSqliteRuntime(packageRoot, sqlitePath) {
  const serverDbModulePath = path.join(packageRoot, "src", "db", "server-db.js");
  if (!fs.existsSync(serverDbModulePath)) {
    throw new Error(`Missing SQLite runtime initializer at ${serverDbModulePath}`);
  }

  const previousDbType = process.env.DB_TYPE;
  const previousSqlitePath = process.env.SQLITE_PATH;

  process.env.DB_TYPE = "sqlite";
  process.env.SQLITE_PATH = sqlitePath;

  try {
    delete require.cache[require.resolve(serverDbModulePath)];
    require(serverDbModulePath);
  } finally {
    if (previousDbType == null) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = previousDbType;

    if (previousSqlitePath == null) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = previousSqlitePath;
  }
}

function removeDeskRpgHome(runtimePaths) {
  const homeDir = runtimePaths.getDeskRpgHomeDir();
  if (!fs.existsSync(homeDir)) {
    console.log(`DeskRPG home does not exist at ${homeDir}`);
    return homeDir;
  }

  fs.rmSync(homeDir, { recursive: true, force: true });
  console.log(`Removed DeskRPG home at ${homeDir}`);
  return homeDir;
}

async function runInit() {
  const runtimePaths = loadRuntimePathsModule();
  const packageRoot = getPackageRoot();
  const envExamplePath =
    process.env.DESKRPG_ENV_EXAMPLE_PATH || path.join(packageRoot, ".env.example");
  const runtimeHome = runtimePaths.ensureDeskRpgHome({ envExamplePath });

  if (process.env.DESKRPG_SKIP_DB_PUSH !== "1") {
    initializeSqliteRuntime(packageRoot, runtimeHome.sqlitePath);
  }

  console.log(`DeskRPG home ready at ${runtimeHome.homeDir}`);
  console.log("Next step: deskrpg start");
}

function loadStartupCheckModule() {
  return require(path.join(getPackageRoot(), "src", "lib", "startup-check.js"));
}

/** One line of doctor output. Makes OK / warning / failure visible per item. */
function reportCheck(status, label, detail) {
  const marker = msg(`doctor.marker.${status}`);
  const line = detail ? `[${marker}] ${label} — ${detail}` : `[${marker}] ${label}`;
  if (status === "fail") console.error(line);
  else console.log(line);
}

/** The port doctor checks. Uses the same argument rules as start (-p/--port/--port=). */
function parseDoctorPort() {
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-p" || args[i] === "--port") && args[i + 1]) return parseInt(args[i + 1], 10);
    const inlineMatch = args[i].match(/^--port=(\d+)$/);
    if (inlineMatch) return parseInt(inlineMatch[1], 10);
  }
  const fromEnv = parseInt(process.env.PORT, 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 3000;
}

const HOST_SETUP_KEY = "DESKRPG_HOST_SETUP_ENABLED";
const HERMES_INSTALL_KEY = "DESKRPG_HERMES_INSTALL_ENABLED";

function readSwitch(envText, key) {
  const match = envText.match(new RegExp(`^${key}=(.*)$`, "m"));
  const value = (match?.[1] ?? "").trim().toLowerCase();
  // Since 2026-09-19 both switches default to on (for admins). Only an explicit off value is off.
  return !["0", "false", "no", "off"].includes(value);
}

/**
 * Turn the host setup switches on and off.
 *
 * Since 2026-09-19 the default is on — admins (system_admin) can use local/SSH connections and Hermes install
 * in the connection wizard right away (Dante's decision). This command is how operators turn it **off**. The switches
 * still live outside the app and cannot be toggled from the web UI — only someone with a terminal can change them.
 */
async function runHostSetup(argv) {
  const runtimePaths = loadRuntimePathsModule();
  const envPath = runtimePaths.getDeskRpgEnvPath();
  if (!fs.existsSync(envPath)) {
    console.error("DeskRPG is not initialized yet. Run 'deskrpg init' first.");
    return 1;
  }

  const action = argv[0] || "status";
  const withInstall = argv.includes("--with-install");
  let envText = fs.readFileSync(envPath, "utf8");

  if (action === "status") {
    const host = readSwitch(envText, HOST_SETUP_KEY);
    const install = readSwitch(envText, HERMES_INSTALL_KEY);
    const state = (on) => msg(on ? "hostSetup.on" : "hostSetup.off");
    console.log(msg("hostSetup.statusHost", { state: state(host) }));
    console.log(msg("hostSetup.statusInstall", { state: state(install) }));
    if (!host) console.log(msg("hostSetup.howToEnable"));
    return 0;
  }

  if (action !== "on" && action !== "off") {
    console.error("Usage: deskrpg host-setup <on|off|status> [--with-install]");
    return 1;
  }

  const enabled = action === "on";
  envText = runtimePaths.upsertEnvLine(envText, HOST_SETUP_KEY, enabled ? "1" : "0");
  // Install is the riskier one, so it is required explicitly only when turning on, and is turned off along with the other.
  if (!enabled || withInstall)
    envText = runtimePaths.upsertEnvLine(envText, HERMES_INSTALL_KEY, enabled ? "1" : "0");
  fs.writeFileSync(envPath, envText, { mode: 0o600 });

  console.log(
    enabled
      ? msg("hostSetup.enabled", {
          install: withInstall ? msg("hostSetup.enabledWithInstall") : "",
        })
      : msg("hostSetup.disabled"),
  );
  console.log(msg("hostSetup.restartToApply"));
  if (enabled && !withInstall) console.log(msg("hostSetup.howToInstall"));
  return 0;
}

async function runDoctor() {
  const runtimePaths = loadRuntimePathsModule();
  const envPath = runtimePaths.getDeskRpgEnvPath();
  const dataDir = runtimePaths.getDeskRpgDataDir();
  const uploadsDir = runtimePaths.getDeskRpgUploadsDir();
  const logsDir = runtimePaths.getDeskRpgLogsDir();
  const packageRoot = getPackageRoot();
  const standaloneAppRoot = findStandaloneAppRoot();

  if (!fs.existsSync(envPath)) {
    console.error(
      `DeskRPG is not initialized at ${runtimePaths.getDeskRpgHomeDir()}. Run "deskrpg init" first.`,
    );
    process.exit(1);
  }
  reportCheck("ok", msg("doctor.runtimeInit"), envPath);

  const missingDirs = [dataDir, uploadsDir, logsDir].filter((dirPath) => !fs.existsSync(dirPath));
  if (missingDirs.length > 0) {
    console.error(`DeskRPG runtime is incomplete. Missing: ${missingDirs.join(", ")}`);
    process.exit(1);
  }
  reportCheck("ok", msg("doctor.runtimeDirs"), msg("doctor.runtimeDirsOk"));

  if (process.env.DESKRPG_SKIP_BUILD_CHECK !== "1") {
    const requiredBuildPaths = standaloneAppRoot
      ? [
          path.join(standaloneAppRoot, "server.js"),
          path.join(standaloneAppRoot, ".next", "server"),
          path.join(packageRoot, "public"),
          path.join(packageRoot, ".next", "static"),
        ]
      : [
          path.join(packageRoot, "server.js"),
          path.join(packageRoot, "public"),
          path.join(packageRoot, ".next", "required-server-files.json"),
          path.join(packageRoot, ".next", "server"),
          path.join(packageRoot, ".next", "static"),
        ];

    const missingBuildPaths = requiredBuildPaths.filter((targetPath) => !fs.existsSync(targetPath));
    if (missingBuildPaths.length > 0) {
      console.error(
        `DeskRPG package is incomplete. Missing runtime files: ${missingBuildPaths.join(", ")}`,
      );
      process.exit(1);
    }
    reportCheck("ok", msg("doctor.build"), msg("doctor.buildOk"));
  }

  // From here on we check "can it actually work", not whether files exist.
  loadEnvFile(envPath);

  const { checkDatabaseReachable, checkPortAvailable, inspectEnvironment } =
    loadStartupCheckModule();
  const inspection = inspectEnvironment(process.env);

  const environmentLabel = msg("doctor.environment");
  for (const warning of inspection.warnings) reportCheck("warn", environmentLabel, warning);
  for (const error of inspection.errors) reportCheck("fail", environmentLabel, error);
  if (inspection.warnings.length === 0 && inspection.errors.length === 0) {
    reportCheck(
      "ok",
      environmentLabel,
      msg("doctor.environmentOk", { target: inspection.dbTarget }),
    );
  }

  // Whether the connection wizard may touch the host. Off is the default and normal, so it is not a failure.
  const offValue = (v) => ["0", "false", "no", "off"].includes((v ?? "").trim().toLowerCase());
  const hostSetupOn = !offValue(process.env.DESKRPG_HOST_SETUP_ENABLED);
  const hermesInstallOn = !offValue(process.env.DESKRPG_HERMES_INSTALL_ENABLED);
  reportCheck(
    "ok",
    msg("doctor.hostSetup"),
    hostSetupOn
      ? msg("doctor.hostSetupOn", {
          install: msg(hermesInstallOn ? "doctor.hermesInstallOn" : "doctor.hermesInstallOff"),
        })
      : msg("doctor.hostSetupOff"),
  );

  // Probe what the app actually uses (inspection.dbTarget). Deciding by whether a URL exists gives a false
  // PostgreSQL failure because of the DATABASE_URL from .env.example left in the SQLite runtime.
  const dbProbe = await checkDatabaseReachable({
    databaseUrl: process.env.DATABASE_URL,
    sqlitePath: process.env.SQLITE_PATH || runtimePaths.getDeskRpgSqlitePath(),
    target: inspection.dbTarget,
  });
  reportCheck(
    dbProbe.ok ? "ok" : "fail",
    msg("doctor.database", { target: dbProbe.target }),
    dbProbe.message,
  );

  const port = parseDoctorPort();
  const portProbe = await checkPortAvailable(port);
  reportCheck(portProbe.free ? "ok" : "warn", msg("doctor.port", { port }), portProbe.message);

  if (inspection.errors.length > 0 || !dbProbe.ok) {
    console.error(msg("doctor.problemsFound"));
    process.exit(1);
  }

  console.log(`DeskRPG runtime looks healthy at ${runtimePaths.getDeskRpgHomeDir()}`);
}

function getPidFilePath() {
  const runtimePaths = loadRuntimePathsModule();
  return path.join(runtimePaths.getDeskRpgHomeDir(), "deskrpg.pid");
}

function writePidFile(pid) {
  fs.writeFileSync(getPidFilePath(), String(pid), "utf8");
}

function removePidFile() {
  const pidPath = getPidFilePath();
  if (fs.existsSync(pidPath)) fs.rmSync(pidPath);
}

function readPidFile() {
  const pidPath = getPidFilePath();
  if (!fs.existsSync(pidPath)) return null;
  const pid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
  if (isNaN(pid)) return null;
  return pid;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseStartArgs() {
  let portOverride = null;
  let daemon = false;
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-p" || args[i] === "--port") && args[i + 1]) {
      portOverride = args[i + 1];
      i++;
    } else if (args[i].match(/^--port=(\d+)$/)) {
      portOverride = args[i].match(/^--port=(\d+)$/)[1];
    } else if (args[i] === "-d" || args[i] === "--daemon") {
      daemon = true;
    }
  }
  return { portOverride, daemon };
}

async function runStart() {
  const runtimePaths = loadRuntimePathsModule();
  const envPath = runtimePaths.getDeskRpgEnvPath();

  if (!fs.existsSync(envPath)) {
    console.error(
      `DeskRPG is not initialized at ${runtimePaths.getDeskRpgHomeDir()}. Run "deskrpg init" first.`,
    );
    process.exit(1);
  }

  // Check if already running
  const existingPid = readPidFile();
  if (existingPid && isProcessRunning(existingPid)) {
    console.error(`DeskRPG is already running (PID ${existingPid}). Use "deskrpg stop" first.`);
    process.exit(1);
  }

  const { portOverride, daemon } = parseStartArgs();

  process.env.DESKRPG_HOME = runtimePaths.getDeskRpgHomeDir();
  process.env.DESKRPG_ENV_PATH = envPath;
  const { applyEnvText } = require(path.join(getPackageRoot(), "src/lib/runtime-env-bootstrap.js"));
  applyEnvText(fs.readFileSync(envPath, "utf8"), process.env);
  if (portOverride) process.env.PORT = portOverride;
  prepareStandaloneRuntime();
  const serverRoot = getPackageRoot();
  ensureExternalModuleAliases(serverRoot);

  const childArgs = [
    "--import",
    pathToFileURL(getTsxLoaderPath()).href,
    path.join(serverRoot, "server.js"),
  ];

  if (daemon) {
    const logsDir = runtimePaths.getDeskRpgLogsDir();
    const logFile = path.join(logsDir, "deskrpg.log");
    const out = fs.openSync(logFile, "a");
    const err = fs.openSync(logFile, "a");

    const child = spawn(process.execPath, childArgs, {
      cwd: serverRoot,
      stdio: ["ignore", out, err],
      env: process.env,
      detached: true,
    });

    writePidFile(child.pid);
    child.unref();

    const port = process.env.PORT || "3000";
    console.log(`DeskRPG server started in background (PID ${child.pid})`);
    console.log(`  URL:  http://localhost:${port}`);
    console.log(`  Logs: ${logFile}`);
    console.log(`  Stop: deskrpg stop`);
    return 0;
  }

  // Foreground mode
  const child = spawn(process.execPath, childArgs, {
    cwd: serverRoot,
    stdio: "inherit",
    env: process.env,
  });

  writePidFile(child.pid);

  return await new Promise((resolve, reject) => {
    let signaled = false;

    const forwardSignal = (sig) => {
      if (signaled) return;
      signaled = true;
      if (!child.killed) child.kill(sig);
    };

    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);

    child.on("error", (error) => {
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
      removePidFile();
      reject(error);
    });

    child.on("exit", (code) => {
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
      removePidFile();
      resolve(signaled ? 0 : (code ?? 0));
    });
  });
}

async function runStop() {
  const pid = readPidFile();
  if (!pid) {
    console.log("No running DeskRPG server found.");
    return;
  }

  if (!isProcessRunning(pid)) {
    console.log(`PID ${pid} is not running. Cleaning up stale PID file.`);
    removePidFile();
    return;
  }

  console.log(`Stopping DeskRPG server (PID ${pid})...`);
  process.kill(pid, "SIGTERM");

  // Wait up to 5 seconds for graceful shutdown
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!isProcessRunning(pid)) {
      removePidFile();
      console.log("DeskRPG server stopped.");
      return;
    }
  }

  // Force kill if still alive
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already dead */
  }
  removePidFile();
  console.log("DeskRPG server forcefully stopped.");
}

async function runRemove() {
  const runtimePaths = loadRuntimePathsModule();
  removeDeskRpgHome(runtimePaths);
}

async function runUpdate() {
  const pkg = require(path.join(getPackageRoot(), "package.json"));
  const currentVersion = pkg.version;
  console.log(`Current version: ${currentVersion}`);

  let latestVersion;
  try {
    latestVersion = execSync("npm view deskrpg version", {
      encoding: "utf8",
    }).trim();
  } catch {
    console.error("Failed to check latest version. Check your network connection.");
    process.exit(1);
  }

  if (latestVersion === currentVersion) {
    console.log("Already up to date.");
    return;
  }

  console.log(`New version available: ${latestVersion}`);
  console.log("Updating...");

  try {
    execSync(`npm install -g deskrpg@${latestVersion}`, { stdio: "inherit" });
  } catch {
    console.error("Update failed. Try manually: npm install -g deskrpg@latest");
    process.exit(1);
  }

  console.log(`Updated deskrpg ${currentVersion} → ${latestVersion}`);
}

async function runUninstall() {
  const runtimePaths = loadRuntimePathsModule();
  removeDeskRpgHome(runtimePaths);
  console.log("DeskRPG runtime data was removed.");
  console.log("Uninstalling global package...");

  try {
    execSync("npm uninstall -g deskrpg", { stdio: "inherit" });
    console.log("DeskRPG has been completely uninstalled.");
  } catch {
    console.error("Failed to uninstall global package. Try manually: npm uninstall -g deskrpg");
  }
}

function parseCreateUserArgs() {
  const args = process.argv.slice(3);
  const result = {
    loginId: null,
    nickname: null,
    password: null,
    passwordStdin: false,
    role: "user",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--login-id" && args[i + 1]) {
      result.loginId = args[++i];
    } else if (args[i] === "--nickname" && args[i + 1]) {
      result.nickname = args[++i];
    } else if (args[i] === "--password" && args[i + 1]) {
      result.password = args[++i];
    } else if (args[i] === "--password-stdin") {
      result.passwordStdin = true;
    } else if (args[i] === "--role" && args[i + 1]) {
      result.role = args[++i];
    }
  }
  return result;
}

/** Read stdin to the end. For `echo pw | deskrpg create-user --password-stdin`. */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/**
 * Read one line without echo. Intercepts readline's output so typed characters are not written
 * to the screen — keeps them from shoulder-surfers and out of terminal scrollback.
 */
function promptPassword(label = "Password: ") {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const onWrite = (chunk, encoding, callback) => {
      // The label itself must show, but the echo of the input after it is swallowed.
      if (chunk.toString() !== label) return callback();
      return rlWrite.call(process.stdout, chunk, encoding, callback);
    };
    const rlWrite = process.stdout.write;
    process.stdout.write = onWrite;
    rl.question(label, (answer) => {
      process.stdout.write = rlWrite;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
    rl.on("error", (err) => {
      process.stdout.write = rlWrite;
      reject(err);
    });
  });
}

async function runCreateUser() {
  const args = parseCreateUserArgs();
  const { loginId, nickname, role } = args;

  if (!loginId || !nickname) {
    console.error(
      "Usage: deskrpg create-user --login-id ID --nickname NAME [--password PW | --password-stdin] [--role admin|user]",
    );
    process.exit(1);
  }

  let password;
  try {
    const { resolvePassword } = loadCliPasswordModule();
    password = await resolvePassword({
      passwordArg: args.password,
      fromStdin: args.passwordStdin,
      readStdin,
      promptPassword,
      isTty: Boolean(process.stdin.isTTY),
    });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (loginId.length < 2 || loginId.length > 50) {
    console.error("Error: login-id must be 2-50 characters");
    process.exit(1);
  }
  if (nickname.length < 2 || nickname.length > 50) {
    console.error("Error: nickname must be 2-50 characters");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Error: password must be at least 8 characters");
    process.exit(1);
  }
  if (!["admin", "user"].includes(role)) {
    console.error("Error: role must be 'admin' or 'user'");
    process.exit(1);
  }

  // Load env — try runtime .env first, then DATABASE_URL from environment
  const runtimePaths = loadRuntimePathsModule();
  const envPath = runtimePaths.getDeskRpgEnvPath();
  if (fs.existsSync(envPath)) {
    loadEnvFile(envPath);
  }

  const dbUrl = process.env.DATABASE_URL;
  const dbType = process.env.DB_TYPE;
  const sqlitePath = process.env.SQLITE_PATH;

  // Hash password
  const bcrypt = require("bcryptjs");
  const passwordHash = await bcrypt.hash(password, 10);
  const systemRole = role === "admin" ? "system_admin" : "user";

  if (dbType === "sqlite" || (!dbUrl && sqlitePath)) {
    // SQLite mode
    const resolvedPath = sqlitePath || path.join(runtimePaths.getDeskRpgDataDir(), "deskrpg.db");
    if (!fs.existsSync(resolvedPath)) {
      console.error(
        `Error: SQLite database not found at ${resolvedPath}. Run "deskrpg init" first.`,
      );
      process.exit(1);
    }
    const Database = require("better-sqlite3");
    const db = new Database(resolvedPath);
    try {
      const existing = db
        .prepare("SELECT id FROM users WHERE login_id = ? OR nickname = ?")
        .get(loginId, nickname);
      if (existing) {
        console.error("Error: login_id or nickname already taken");
        process.exit(1);
      }
      const { randomUUID } = require("node:crypto");
      const id = randomUUID();
      db.prepare(
        "INSERT INTO users (id, login_id, nickname, password_hash, system_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        loginId,
        nickname,
        passwordHash,
        systemRole,
        new Date().toISOString(),
        new Date().toISOString(),
      );
      console.log(`User created successfully:`);
      console.log(`  ID:       ${id}`);
      console.log(`  Login ID: ${loginId}`);
      console.log(`  Nickname: ${nickname}`);
      console.log(`  Role:     ${systemRole}`);
    } finally {
      db.close();
    }
  } else if (dbUrl) {
    // PostgreSQL mode
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: dbUrl });
    try {
      const { rows: existing } = await pool.query(
        "SELECT id FROM users WHERE login_id = $1 OR nickname = $2 LIMIT 1",
        [loginId, nickname],
      );
      if (existing.length > 0) {
        console.error("Error: login_id or nickname already taken");
        process.exit(1);
      }
      const { rows } = await pool.query(
        "INSERT INTO users (login_id, nickname, password_hash, system_role) VALUES ($1, $2, $3, $4) RETURNING id",
        [loginId, nickname, passwordHash, systemRole],
      );
      const id = rows[0].id;
      console.log(`User created successfully:`);
      console.log(`  ID:       ${id}`);
      console.log(`  Login ID: ${loginId}`);
      console.log(`  Nickname: ${nickname}`);
      console.log(`  Role:     ${systemRole}`);
    } finally {
      await pool.end();
    }
  } else {
    console.error("Error: No database configured. Set DATABASE_URL or run 'deskrpg init' first.");
    process.exit(1);
  }
}

/**
 * The last-resort recovery path when the admin is locked out — opens the DB directly on the host
 * and issues a temporary password. The plaintext appears on screen once and is never stored.
 */
async function runResetPassword() {
  const loginId = process.argv[3];
  if (!loginId || loginId.startsWith("-")) {
    console.error("Usage: deskrpg reset-password <login-id>");
    process.exit(1);
  }

  const runtimePaths = loadRuntimePathsModule();
  const envPath = runtimePaths.getDeskRpgEnvPath();
  if (fs.existsSync(envPath)) {
    loadEnvFile(envPath);
  }

  const dbUrl = process.env.DATABASE_URL;
  const dbType = process.env.DB_TYPE;
  const sqlitePath = process.env.SQLITE_PATH;

  const { randomBytes } = require("node:crypto");
  const temporaryPassword = randomBytes(16).toString("base64url");
  const bcrypt = require("bcryptjs");
  const passwordHash = await bcrypt.hash(temporaryPassword, 10);

  let user = null;

  if (dbType === "sqlite" || (!dbUrl && sqlitePath)) {
    const resolvedPath = sqlitePath || path.join(runtimePaths.getDeskRpgDataDir(), "deskrpg.db");
    if (!fs.existsSync(resolvedPath)) {
      console.error(
        `Error: SQLite database not found at ${resolvedPath}. Run "deskrpg init" first.`,
      );
      process.exit(1);
    }
    const Database = require("better-sqlite3");
    const db = new Database(resolvedPath);
    try {
      const { resetSqliteUserPassword } = loadCliResetPasswordModule();
      user = resetSqliteUserPassword(db, loginId, passwordHash);
    } finally {
      db.close();
    }
  } else if (dbUrl) {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: dbUrl });
    try {
      const { rows } = await pool.query(
        "UPDATE users SET password_hash = $1, must_change_password = true, updated_at = now() WHERE login_id = $2 RETURNING id, login_id, nickname",
        [passwordHash, loginId],
      );
      user = rows[0]
        ? { id: rows[0].id, loginId: rows[0].login_id, nickname: rows[0].nickname }
        : null;
    } finally {
      await pool.end();
    }
  } else {
    console.error("Error: No database configured. Set DATABASE_URL or run 'deskrpg init' first.");
    process.exit(1);
  }

  if (!user) {
    console.error(`Error: no user with login id '${loginId}'`);
    process.exit(1);
  }

  console.log("Password reset:");
  console.log(`  Login ID:  ${user.loginId}`);
  console.log(`  Nickname:  ${user.nickname}`);
  console.log(`  Temporary: ${temporaryPassword}`);
  console.log("");
  console.log("Hand this over directly. It is shown once and the user must change it at login.");
}

async function main() {
  const command = process.argv[2];

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v" || command === "-V") {
    console.log(getVersion());
    return;
  }

  if (
    !command ||
    ![
      "init",
      "start",
      "stop",
      "create-user",
      "reset-password",
      "update",
      "host-setup",
      "doctor",
      "remove",
      "uninstall",
    ].includes(command)
  ) {
    printUsage();
    process.exit(1);
  }

  if (command === "init") {
    await runInit();
    return;
  }

  if (command === "stop") {
    await runStop();
    return;
  }

  if (command === "create-user") {
    await runCreateUser();
    return;
  }

  if (command === "reset-password") {
    await runResetPassword();
    return;
  }

  if (command === "update") {
    await runUpdate();
    return;
  }

  if (command === "host-setup") {
    process.exit(await runHostSetup(process.argv.slice(3)));
  }

  if (command === "doctor") {
    await runDoctor();
    return;
  }

  if (command === "remove") {
    await runRemove();
    return;
  }

  if (command === "uninstall") {
    await runUninstall();
    return;
  }

  const exitCode = await runStart();
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
