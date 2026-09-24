import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { watchParent } from "./parent-watch";

type ModuleLoader = {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};

async function main(): Promise<void> {
  if (process.env.DESKRPG_CAPTURE_MODE !== "1") {
    throw new Error("The README capture server launcher is capture-only");
  }
  const root = path.resolve(process.env.DESKRPG_PROJECT_ROOT ?? "");
  const entry = path.join(root, "dev-server.ts");
  if (!root || !fs.existsSync(entry)) throw new Error("DeskRPG project root is invalid");

  // If the parent (capture session or test) dies without cleanup, end the whole group. This launcher starts `detached`
  // and leads its group, so `-pid` also points at the workers Next started.
  const parentPid = Number(process.env.DESKRPG_CAPTURE_PARENT_PID);
  if (Number.isInteger(parentPid) && parentPid > 1) {
    watchParent(parentPid, () => {
      console.error(`[readme-capture] parent ${parentPid} is gone; stopping the capture server`);
      try {
        process.kill(-process.pid, "SIGTERM");
      } catch {
        process.exit(1);
      }
    });
  }

  Reflect.set(process, "loadEnvFile", undefined);
  const loader = Module as unknown as ModuleLoader;
  const originalLoad = loader._load;
  loader._load = function captureSafeModuleLoad(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (request !== "@next/env" || !loaded || typeof loaded !== "object") return loaded;
    return {
      ...loaded,
      loadEnvConfig: () => ({
        combinedEnv: process.env,
        parsedEnv: undefined,
        loadedEnvFiles: [],
      }),
    };
  };

  await import(pathToFileURL(entry).href);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
