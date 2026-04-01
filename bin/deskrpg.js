#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn, execSync } = require("node:child_process");

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

  ensureLinkedRuntimePath(
    path.join(standaloneAppRoot, "public"),
    path.join(packageRoot, "public"),
  );
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
  console.log("  update                Update to the latest version");
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
  console.log("Examples:");
  console.log("  deskrpg init          # First-time setup");
  console.log("  deskrpg start         # Start on default port 3000");
  console.log("  deskrpg start -p 8080 # Start on port 8080");
  console.log("  deskrpg start -d      # Start in background");
  console.log("  deskrpg stop          # Stop background server");
}

function printUsage() {
  console.error("Usage: deskrpg <init|start|stop|update|doctor|remove|uninstall|version|help>");
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
  const envExamplePath = process.env.DESKRPG_ENV_EXAMPLE_PATH || path.join(packageRoot, ".env.example");
  const runtimeHome = runtimePaths.ensureDeskRpgHome({ envExamplePath });

  if (process.env.DESKRPG_SKIP_DB_PUSH !== "1") {
    initializeSqliteRuntime(packageRoot, runtimeHome.sqlitePath);
  }

  console.log(`DeskRPG home ready at ${runtimeHome.homeDir}`);
  console.log("Next step: deskrpg start");
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
    console.error(`DeskRPG is not initialized at ${runtimePaths.getDeskRpgHomeDir()}. Run "deskrpg init" first.`);
    process.exit(1);
  }

  const missingDirs = [dataDir, uploadsDir, logsDir].filter((dirPath) => !fs.existsSync(dirPath));
  if (missingDirs.length > 0) {
    console.error(`DeskRPG runtime is incomplete. Missing: ${missingDirs.join(", ")}`);
    process.exit(1);
  }

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
      console.error(`DeskRPG package is incomplete. Missing runtime files: ${missingBuildPaths.join(", ")}`);
      process.exit(1);
    }
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
    console.error(`DeskRPG is not initialized at ${runtimePaths.getDeskRpgHomeDir()}. Run "deskrpg init" first.`);
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
  loadEnvFile(envPath);
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

    const child = spawn(
      process.execPath,
      childArgs,
      {
        cwd: serverRoot,
        stdio: ["ignore", out, err],
        env: process.env,
        detached: true,
      },
    );

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
  const child = spawn(
    process.execPath,
    childArgs,
    {
      cwd: serverRoot,
      stdio: "inherit",
      env: process.env,
    },
  );

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
  } catch { /* already dead */ }
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
    latestVersion = execSync("npm view deskrpg version", { encoding: "utf8" }).trim();
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

  if (!command || !["init", "start", "stop", "update", "doctor", "remove", "uninstall"].includes(command)) {
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

  if (command === "update") {
    await runUpdate();
    return;
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
