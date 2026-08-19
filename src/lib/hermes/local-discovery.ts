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
  probe: (baseUrl: string, profile: string) => Promise<"hermes" | "not-hermes" | "unreachable">;
};

/**
 * 파일시스템 목록과 게이트웨이 탐침을 겹쳐 후보를 만든다.
 *
 * 파일시스템은 "이름과 토큰이 있다"만 알려주고, 게이트웨이는 "실제로 서빙 중이다"를
 * 알려준다. 각자 상대의 약점을 덮는다(스펙 §6.1).
 */
export async function discoverLocalProfiles(deps: DiscoverDeps): Promise<DiscoveryCandidate[]> {
  const registered = new Set(deps.registeredNames);
  const probed = await Promise.all(
    deps.localProfiles.map(async (p) => {
      let kind: "hermes" | "not-hermes" | "unreachable";
      try {
        kind = await deps.probe(deps.baseUrl, p.name);
      } catch {
        kind = "unreachable";
      }
      return { p, kind };
    }),
  );
  return probed.map(({ p, kind }) => ({
    name: p.name,
    hasToken: p.hasToken,
    servedByGateway: kind === "hermes",
    alreadyRegistered: registered.has(p.name),
  }));
}
