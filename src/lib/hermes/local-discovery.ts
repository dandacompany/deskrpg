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
  /** "hermes" = that gateway serves this profile. */
  probe: (baseUrl: string, profile: string) => Promise<"hermes" | "not-hermes" | "unreachable">;
};

/**
 * Builds candidates by overlaying the filesystem listing with gateway probes.
 *
 * The filesystem only tells "the name and token exist", and the gateway tells "it's actually being served".
 * Each covers the other's weakness (spec §6.1).
 */

// One probe per profile, each of which can hang for up to 8 seconds (gateway-probe.ts DEFAULT_TIMEOUT_MS).
// Firing them all with an unbounded Promise.all means that with many profiles and a slow gateway,
// the page waits on the single slowest probe. 4 is an arbitrary conservative value —
// a local Hermes home rarely has dozens of profiles, and this finishes everything within a few seconds
// while limiting how many requests hit the gateway at once.
const MAX_CONCURRENT_PROBES = 4;

export async function discoverLocalProfiles(deps: DiscoverDeps): Promise<DiscoveryCandidate[]> {
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
