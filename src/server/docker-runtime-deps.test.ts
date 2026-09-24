import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * server.js does `import("./src/server/socket-handlers.ts")` at runtime. Next's
 * standalone tracing can't see this path, so the Dockerfile must COPY the sources directly,
 * and if even one is missing **the container dies at startup** — with tests and build both passing.
 * It has actually happened: eight conversation modules added in phase 2 were missing.
 */
function transitiveLocalDeps(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(path.join(repoRoot, file), "utf8");
    // Check both relative paths and the `@/` alias. Missing the alias silently leaves a hole —
    // open-chat-formatter came in via `@/lib/...` and at first was not traced.
    // Looking only at `from "..."` misses CommonJS entry points — src/db/index.ts and server-db.js
    // load migration modules via `require("./sqlite-...js")`, and those files survived without COPY lines
    // by riding on Next's standalone tracing.
    const specs = [
      ...[...src.matchAll(/from\s+"((?:\.|@\/)[^"]+)"/g)].map((m) => m[1]),
      ...[...src.matchAll(/require\(\s*"((?:\.|@\/)[^"]+)"\s*\)/g)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      const raw = spec.startsWith("@/")
        ? path.join("src", spec.slice(2))
        : path.join(path.dirname(file), spec);
      const resolved = [".ts", ".tsx", ".js", "/index.ts"]
        .map((ext) => (raw.endsWith(ext) ? raw : raw + ext))
        .find((cand) => existsSync(path.join(repoRoot, cand)));
      if (resolved) queue.push(resolved);
    }
  }
  return seen;
}

test("Dockerfile copies every source file the socket server loads at runtime", () => {
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  // COPY takes files and directories. A directory copy covers everything under it.
  const copied = [...dockerfile.matchAll(/COPY --from=builder \/app\/(\S+)/g)].map((m) => m[1]);
  const covered = (file: string) =>
    copied.some((c) => file === c || file.startsWith(c.replace(/\/?$/, "/")));

  // There are two entry points. Whatever server.js itself requires must also be in the image —
  // back when only socket-handlers was scanned, a require newly added to server.js slipped through
  // and staging fell into a MODULE_NOT_FOUND restart loop (observed).
  const missing = [
    ...new Set([
      ...transitiveLocalDeps("src/server/socket-handlers.ts"),
      ...transitiveLocalDeps("server.js"),
    ]),
  ]
    .filter((f) => f !== "server.js" && !covered(f))
    .sort();

  assert.deepEqual(
    missing,
    [],
    "Dockerfile 이 COPY 하지 않는 런타임 의존이 있습니다 — 이미지가 기동에서 죽습니다:\n  " +
      missing.join("\n  "),
  );
});

test("Dockerfile never copies a file that no longer exists", () => {
  // Continuing to COPY the deleted meeting-broker.js/openclaw-gateway.js broke docker build
  // for four months. The build only runs at release, so nobody noticed until then.
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const dead = [...dockerfile.matchAll(/COPY --from=builder \/app\/(\S+)/g)]
    .map((m) => m[1])
    .filter((p) => !p.includes("*") && !p.startsWith(".next") && !p.startsWith("node_modules"))
    .filter((p) => !existsSync(path.join(repoRoot, p)));

  assert.deepEqual(dead, [], `Dockerfile 이 없는 경로를 COPY 합니다: ${dead.join(", ")}`);
});

test("npm allowlist includes every socket server runtime source dependency", () => {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    files: string[];
  };
  const missing = [...transitiveLocalDeps("src/server/socket-handlers.ts")].filter(
    (file) => !manifest.files.some((entry) => file === entry || file.startsWith(`${entry}/`)),
  );
  assert.deepEqual(missing.sort(), [], "npm package would omit runtime dependencies");
});

test("the image's layer count stays well below the overlay2 limit", () => {
  // Linux overlay2 can't unpack images with more than 125 layers (`failed to register layer: max depth
  // exceeded`). 2026.921.2 was published with 126 layers and `docker pull` failed — build, push and manifest checks
  // were all green, and nobody knew until actually pulling it. Each COPY/RUN/ADD line is one layer.
  // The base image (node:22-bookworm-slim) uses around 5, so leave a wide margin.
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const runner = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  const layers = runner.split("\n").filter((line) => /^(COPY|RUN|ADD)\b/.test(line)).length;
  assert.ok(
    layers <= 90,
    `runner 단계가 레이어 ${layers}개를 만든다 — 파일마다 COPY 하지 말고 디렉터리째 복사하라`,
  );
});
