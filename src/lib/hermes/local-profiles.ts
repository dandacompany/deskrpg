/**
 * 로컬 Hermes 설치에서 프로필을 발견한다.
 *
 * Hermes API Server에는 프로필을 나열하는 엔드포인트가 없고(스펙 §2.1), 대시보드의
 * profiles.list RPC는 외부 서버에 인증 경로가 없다(§2.2). 앱과 Hermes가 같은
 * 머신일 때만 쓸 수 있는 경로가 파일시스템이다.
 *
 * 파일시스템은 순수 함수 밖으로 밀어낸다 — 테스트가 실제 홈 디렉토리에 의존하면
 * 실행하는 사람마다 결과가 달라진다.
 */

/** Hermes가 프로필 키에 요구하는 최소 길이 (hermes_cli.auth.has_usable_secret). */
const MIN_TOKEN_LENGTH = 16;

/** src/app/api/gateways/[id]/profiles/validation.ts 와 같은 규칙. */
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]*[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ProfileFs = {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string, enc: "utf8"): string;
  statIsDirectory(p: string): boolean;
};

export type LocalProfile = { name: string; hasToken: boolean };

/**
 * 프로필 디렉토리의 위치. hermes_cli/profiles.py 의 _get_profiles_root 규칙을 따른다 —
 * "In Docker/custom deployments where HERMES_HOME points outside ~/.hermes,
 *  profiles live under HERMES_HOME/profiles/ so they persist on the mounted volume."
 */
export function resolveProfilesRoot(
  env: Record<string, string | undefined>,
  homedir: string,
): string {
  const defaultHome = `${homedir}/.hermes`;
  const override = (env.HERMES_HOME || "").trim();
  if (
    !override ||
    override === defaultHome ||
    override.startsWith(defaultHome + "/")
  ) {
    // HERMES_HOME이 없거나 ~/.hermes 안을 가리킨다(그 자체가 프로필일 수 있다).
    // 어느 쪽이든 프로필 루트는 ~/.hermes/profiles 다.
    return `${defaultHome}/profiles`;
  }
  return `${override.replace(/\/+$/, "")}/profiles`;
}

function parseEnvValue(contents: string, key: string): string | null {
  let found: string | null = null;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(`${key}=`)) continue;
    let value = line.slice(key.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // 마지막 정의가 이긴다 — 키를 여러 번 append 했을 수 있다.
    found = value;
  }
  return found || null;
}

/**
 * 프로필의 API_SERVER_KEY. named 프로필은 자기 .env, default는 루트의 부모 .env.
 * 실측: ~/.hermes/profiles/default/ 에는 .env가 없다 — default의 홈은 ~/.hermes 자체다.
 */
export function readProfileToken(
  root: string,
  name: string,
  fs: ProfileFs,
): string | null {
  // Defence in depth: `name` here is not guaranteed to have passed PROFILE_NAME_RE —
  // this function's own callers may not validate it (Task 4 review, Critical 1: a
  // registration batch endpoint fed unvalidated names straight into this path
  // concatenation, letting "../../../../srv/otherapp" read an arbitrary .env off the
  // box). "default" is the one legitimate exception the branch below already special-
  // cases. Do not delete this as "redundant with PROFILE_NAME_RE at the call site" —
  // a future caller may skip that check the way this one did.
  if (name !== "default" && !PROFILE_NAME_RE.test(name)) return null;
  const envPath =
    name === "default"
      ? `${root.replace(/\/profiles$/, "")}/.env`
      : `${root}/${name}/.env`;
  if (!fs.existsSync(envPath)) return null;
  let contents: string;
  try {
    contents = fs.readFileSync(envPath, "utf8");
  } catch {
    return null;
  }
  return parseEnvValue(contents, "API_SERVER_KEY");
}

/**
 * config.yaml 을 가진 하위 디렉토리를 프로필 후보로 본다.
 *
 * 이 목록만으로 판단하면 안 된다. 실측상 ~/.hermes/profiles/ 에는 acestep_output
 * 처럼 에이전트가 아닌 디렉토리도 같은 레이아웃을 갖고 있다. 호출자가 게이트웨이
 * 탐침과 겹쳐서 최종 판단한다(스펙 §6.1).
 */
export function listLocalProfiles(root: string, fs: ProfileFs): LocalProfile[] {
  if (!fs.existsSync(root)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: LocalProfile[] = [];
  for (const name of entries.sort()) {
    if (!PROFILE_NAME_RE.test(name)) continue;
    const dir = `${root}/${name}`;
    if (!fs.statIsDirectory(dir)) continue;
    if (!fs.existsSync(`${dir}/config.yaml`)) continue;
    const token = readProfileToken(root, name, fs);
    out.push({ name, hasToken: !!token && token.length >= MIN_TOKEN_LENGTH });
  }
  return out;
}

/** 실제 파일시스템을 쓰는 기본 구현. 서버 코드에서만 부른다. */
export function nodeProfileFs(): ProfileFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  return {
    existsSync: (p) => nodeFs.existsSync(p),
    readdirSync: (p) => nodeFs.readdirSync(p),
    readFileSync: (p, enc) => nodeFs.readFileSync(p, enc),
    statIsDirectory: (p) => {
      try {
        return nodeFs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
  };
}
