import type { LocalProfile } from "./local-profiles";

export type DiscoveryCandidate = {
  name: string;
  hasToken: boolean;
  servedByGateway: boolean;
  alreadyRegistered: boolean;
};

export type DiscoverDeps = {
  baseUrl: string;
  localProfiles: LocalProfile[];
  registeredNames: string[];
  /** "hermes" = 그 게이트웨이가 이 프로필을 서빙한다. */
  probe: (
    baseUrl: string,
    profile: string,
  ) => Promise<"hermes" | "not-hermes" | "unreachable">;
};

/**
 * 파일시스템 목록과 게이트웨이 탐침을 겹쳐 후보를 만든다.
 *
 * 파일시스템은 "이름과 토큰이 있다"만 알려주고, 게이트웨이는 "실제로 서빙 중이다"를
 * 알려준다. 각자 상대의 약점을 덮는다(스펙 §6.1).
 */

// 프로필 하나당 탐침 하나, 각각 최대 8초(gateway-probe.ts DEFAULT_TIMEOUT_MS)까지
// 매달릴 수 있다. 상한 없이 Promise.all로 전부 던지면 프로필이 많고 게이트웨이가
// 느릴 때 페이지가 가장 느린 탐침 하나를 기다리게 된다. 4는 임의의 보수적인 값—
// 로컬 Hermes 홈 하나에 프로필이 수십 개 있는 경우는 드물고, 이 정도면 몇 초 안에
// 전부 끝나면서도 게이트웨이에 순간적으로 몰리는 요청 수를 좁혀 둔다.
const MAX_CONCURRENT_PROBES = 4;

export async function discoverLocalProfiles(
  deps: DiscoverDeps,
): Promise<DiscoveryCandidate[]> {
  const registered = new Set(deps.registeredNames);
  const kinds: ("hermes" | "not-hermes" | "unreachable")[] = new Array(deps.localProfiles.length);
  let nextIndex = 0;
  async function worker() {
    for (let i = nextIndex++; i < deps.localProfiles.length; i = nextIndex++) {
      try {
        kinds[i] = await deps.probe(deps.baseUrl, deps.localProfiles[i].name);
      } catch {
        kinds[i] = "unreachable";
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_PROBES, deps.localProfiles.length) }, worker),
  );
  return deps.localProfiles.map((p, i) => ({
    name: p.name,
    hasToken: p.hasToken,
    servedByGateway: kinds[i] === "hermes",
    alreadyRegistered: registered.has(p.name),
  }));
}
