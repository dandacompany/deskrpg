/**
 * Questions an NPC asks its user mid-chat through the plugin tool `deskrpg_ask_user`.
 *
 * The plugin holds the waiting questions (in memory, next to the blocked tool call); DeskRPG keeps no
 * copy. What ties a question to a person is the context DeskRPG registered with the chat session —
 * `{userId, npcId, channelId}` — which the plugin echoes back. Every read and answer here filters on
 * it, so nobody sees or answers another user's question.
 */
import { and, eq, isNotNull } from "drizzle-orm";

import { db, gatewayResources, hermesProfiles, npcs } from "@/db";
import { decryptGatewayToken } from "@/lib/gateway-resources";
import { restorePluginInfo } from "@/lib/hermes/plugin-cache-update";
import { supportsAskUser } from "@/lib/hermes/plugin-capability";
import { createProfilePluginClient } from "@/lib/hermes/plugin-client";
import type { NpcQuestion, ProfilePluginClient } from "@/lib/hermes/plugin-client-types";

export type AskUserContext = { userId: string; npcId: string; channelId: string };

export type UserQuestion = {
  id: string;
  npcId: string;
  /** From `hermes_profiles`, never `npcs.name`. null when the profile has no display name. */
  npcName: string | null;
  question: string;
  choices: string[];
  allowOther: boolean;
  createdAt: string;
};

export type AnswerOutcome = "answered" | "not_found" | "invalid" | "failed";

type ProfileRow = {
  npcId: string;
  profileName: string;
  displayName: string | null;
  tokenEncrypted: string;
  baseUrl: string;
  pluginInfoJson: string | null;
};

function clientFor(row: ProfileRow): ProfilePluginClient | null {
  if (!supportsAskUser(restorePluginInfo(row.pluginInfoJson))) return null;
  return createProfilePluginClient({
    baseUrl: row.baseUrl,
    profileName: row.profileName,
    profileToken: decryptGatewayToken(row.tokenEncrypted),
  });
}

const profileColumns = {
  npcId: npcs.id,
  profileName: hermesProfiles.profileName,
  displayName: hermesProfiles.displayName,
  tokenEncrypted: hermesProfiles.tokenEncrypted,
  baseUrl: gatewayResources.baseUrl,
  pluginInfoJson: gatewayResources.pluginInfoJson,
};

async function profileOfNpc(npcId: string): Promise<ProfileRow | null> {
  const [row] = await db
    .select(profileColumns)
    .from(npcs)
    .innerJoin(hermesProfiles, eq(npcs.hermesProfileId, hermesProfiles.id))
    .innerJoin(gatewayResources, eq(hermesProfiles.gatewayId, gatewayResources.id))
    .where(eq(npcs.id, npcId))
    .limit(1);
  return (row as ProfileRow | undefined) ?? null;
}

function contextOf(question: NpcQuestion): Partial<AskUserContext> {
  const ctx = question.context ?? {};
  const read = (key: keyof AskUserContext) => (typeof ctx[key] === "string" ? ctx[key] : undefined);
  return { userId: read("userId"), npcId: read("npcId"), channelId: read("channelId") };
}

/**
 * Tells the plugin this chat session has someone to answer. false when the NPC's gateway has no
 * `ask_user` or the call failed — the tool then answers "no user" and the NPC asks in plain text.
 */
export async function registerAskUserSession(
  input: AskUserContext & { sessionId: string },
): Promise<boolean> {
  const row = await profileOfNpc(input.npcId);
  const client = row && clientFor(row);
  if (!client) return false;
  const res = await client.askUser.registerSession(input.sessionId, {
    userId: input.userId,
    npcId: input.npcId,
    channelId: input.channelId,
  });
  return res.ok;
}

/** Whether this NPC's gateway can ask at all — the socket layer skips everything when it can't. */
export async function npcCanAskUser(npcId: string): Promise<boolean> {
  const row = await profileOfNpc(npcId);
  return Boolean(row && clientFor(row));
}

/** The questions a session is waiting on that belong to this user and NPC. */
export async function sessionQuestions(input: {
  npcId: string;
  userId: string;
  sessionId: string;
}): Promise<UserQuestion[]> {
  const row = await profileOfNpc(input.npcId);
  const client = row && clientFor(row);
  if (!row || !client) return [];
  const res = await client.askUser.listQuestions(input.sessionId);
  if (!res.ok) return [];
  return res.data.questions
    .filter((q) => {
      const ctx = contextOf(q);
      return ctx.userId === input.userId && ctx.npcId === input.npcId;
    })
    .map((q) => viewOf(q, row));
}

function viewOf(q: NpcQuestion, row: Pick<ProfileRow, "npcId" | "displayName">): UserQuestion {
  return {
    id: q.id,
    npcId: row.npcId,
    npcName: row.displayName ?? null,
    question: q.question,
    choices: q.choices,
    allowOther: q.allow_other,
    createdAt: q.created_at,
  };
}

/** Every waiting question in this channel addressed to this user — the attention inbox's rows. */
export async function listUserQuestions(
  channelId: string,
  userId: string,
): Promise<UserQuestion[]> {
  const rows = (await db
    .select(profileColumns)
    .from(npcs)
    .innerJoin(hermesProfiles, eq(npcs.hermesProfileId, hermesProfiles.id))
    .innerJoin(gatewayResources, eq(hermesProfiles.gatewayId, gatewayResources.id))
    .where(and(eq(npcs.channelId, channelId), isNotNull(npcs.hermesProfileId)))) as ProfileRow[];

  const out: UserQuestion[] = [];
  // One plugin read per profile: several NPCs can share a profile only across channels, but stay safe.
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.baseUrl}|${row.profileName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const client = clientFor(row);
    if (!client) continue;
    const res = await client.askUser.listQuestions();
    if (!res.ok) continue;
    for (const q of res.data.questions) {
      const ctx = contextOf(q);
      if (ctx.userId !== userId || ctx.channelId !== channelId) continue;
      const npc = rows.find((r) => r.npcId === ctx.npcId);
      if (npc) out.push(viewOf(q, npc));
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Answers a question — only its own user may. Anything else reads as `not_found`. */
export async function answerNpcQuestion(input: {
  userId: string;
  npcId: string;
  questionId: string;
  response: string;
}): Promise<AnswerOutcome> {
  const row = await profileOfNpc(input.npcId);
  const client = row && clientFor(row);
  if (!client) return "not_found";
  const listed = await client.askUser.listQuestions();
  if (!listed.ok) return "failed";
  const question = listed.data.questions.find((q) => q.id === input.questionId);
  if (!question) return "not_found";
  const ctx = contextOf(question);
  if (ctx.userId !== input.userId || ctx.npcId !== input.npcId) return "not_found";
  const res = await client.askUser.answer(input.questionId, input.response);
  if (res.ok) return "answered";
  if (res.status === 404) return "not_found";
  if (res.status === 400) return "invalid";
  return "failed";
}
