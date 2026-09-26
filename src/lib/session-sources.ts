/**
 * Reads what a Hermes session read, with **that profile's key** (`/p/{profile}/deskrpg/sessions/{id}/sources`).
 * The profile must be registered on the channel's gateway; without its key the owner key is not used
 * instead (fail-closed) and the view says the sources are unavailable.
 */
import { and, eq } from "drizzle-orm";
import type { NextResponse } from "next/server";

import { db, hermesProfiles } from "@/db";
import { pluginFailureResponse } from "@/lib/cron-access";
import { decryptGatewayToken } from "@/lib/gateway-resources";
import {
  SESSION_SOURCES_CAPABILITY,
  SESSION_SOURCES_MIN_VERSION,
} from "@/lib/hermes/deskrpg-plugin-types";
import { createProfilePluginClient } from "@/lib/hermes/plugin-client";
import type { SessionSourcesView } from "@/lib/session-sources-types";
import { sourcesWithin, type SourcesWindow } from "@/lib/session-sources-window";

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export async function readSessionSources(input: {
  gateway: { id: string; baseUrl: string };
  capabilities: readonly string[];
  profileName: string | null | undefined;
  sessionId: string | null | undefined;
  /** Only sources first read inside this window belong to the work being shown. */
  window?: SourcesWindow;
}): Promise<{ ok: true; view: SessionSourcesView } | { ok: false; response: NextResponse }> {
  const { sessionId, profileName } = input;
  if (!sessionId || !profileName || !SESSION_ID_RE.test(sessionId)) {
    return { ok: true, view: { status: "none" } };
  }
  if (!input.capabilities.includes(SESSION_SOURCES_CAPABILITY)) {
    return {
      ok: true,
      view: {
        status: "unavailable",
        reason: "plugin_upgrade_required",
        minVersion: SESSION_SOURCES_MIN_VERSION,
      },
    };
  }
  const [profile] = await db
    .select({ tokenEncrypted: hermesProfiles.tokenEncrypted })
    .from(hermesProfiles)
    .where(
      and(
        eq(hermesProfiles.gatewayId, input.gateway.id),
        eq(hermesProfiles.profileName, profileName),
      ),
    )
    .limit(1);
  if (!profile?.tokenEncrypted) {
    return { ok: true, view: { status: "unavailable", reason: "no_profile_key" } };
  }
  const client = createProfilePluginClient({
    baseUrl: input.gateway.baseUrl,
    profileName,
    profileToken: decryptGatewayToken(profile.tokenEncrypted),
  });
  const res = await client.sessions.sources(sessionId);
  if (res.ok) {
    return {
      ok: true,
      view: {
        status: "ok",
        sources: sourcesWithin(
          Array.isArray(res.data.sources) ? res.data.sources : [],
          input.window,
        ),
        outsideWorkdirFiles: Number(res.data.outside_workdir_files) || 0,
        truncated: res.data.truncated === true,
      },
    };
  }
  if (res.status === 404 && res.failure.code === "session_not_found") {
    return { ok: true, view: { status: "expired" } };
  }
  return { ok: false, response: pluginFailureResponse(res) };
}
