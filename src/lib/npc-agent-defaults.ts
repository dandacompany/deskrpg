import { OFFICE_PRESETS, applyPresetName } from "./office-presets";
import { PERSONA_PRESETS } from "./npc-persona-presets";
import { injectTaskPrompt } from "./task-prompt";
import { normalizeLocale, type ServerLocale } from "./i18n/server";

export interface NpcPresetDefaults {
  presetId: string;
  displayName: string;
  defaultAgentId: string;
  appearance: {
    bodyType: string;
    layers: Record<string, { itemKey: string; variant: string }>;
  };
  identity: string;
  soul: string;
  meetingProtocol: string;
}

export interface BuildNpcPresetDefaultsOptions {
  presetId: string;
  npcName: string;
  locale?: string;
}

export interface BuildPersonaConfigOptions extends BuildNpcPresetDefaultsOptions {
  identityOverride?: string;
  soulOverride?: string;
  fallbackPersona?: string;
}

export interface GatewayAgentFile {
  name: "IDENTITY.md" | "SOUL.md" | "AGENTS.md";
  content: string;
}

function getOfficePresetOrThrow(presetId: string) {
  const preset = OFFICE_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new Error(`Unknown OFFICE_PRESET: ${presetId}`);
  }
  return preset;
}

type PromptDocumentKind = "identity" | "soul" | "agents";

const LANGUAGE_POLICY_SECTION_TITLES = [
  "Language Policy",
  "언어 정책",
  "言語ポリシー",
  "语言策略",
];

const RESPONSE_LANGUAGE_SECTION_TITLES = [
  "Response Language Contract",
  "응답 언어 계약",
  "応答言語ルール",
  "回复语言约束",
];

const LOCALE_POLICY_CONTENT: Record<ServerLocale, {
  languageName: string;
  identityTitle: string;
  identityLines: string[];
  soulTitle: string;
  soulLines: string[];
  agentsTitle: string;
  agentsLines: string[];
}> = {
  en: {
    languageName: "English",
    identityTitle: "Language Policy",
    identityLines: [
      "Working language: English.",
      "Write every direct reply, meeting contribution, task report, summary, and follow-up question in English.",
      "You may read materials written in other languages, but the words you produce must stay in English unless the human explicitly rewrites this policy.",
    ],
    soulTitle: "Language Policy",
    soulLines: [
      "Your tone, emotional expression, jokes, empathy, and narration must all be expressed in English.",
      "Do not switch to another language just because the source notes or memories contain another language.",
    ],
    agentsTitle: "Response Language Contract",
    agentsLines: [
      "All direct chats, meeting turns, task reports, summaries, and follow-up questions must be written in English.",
      "Treat this as a hard workspace rule unless the human intentionally rewrites the persona files in a different language.",
    ],
  },
  ko: {
    languageName: "한국어",
    identityTitle: "언어 정책",
    identityLines: [
      "현재 작업 언어는 한국어다.",
      "직접 대화, 회의 발언, 태스크 보고, 요약, 후속 질문은 모두 한국어로 작성한다.",
      "참고 자료가 다른 언어여도 출력하는 말과 글은 인간이 이 정책을 다시 쓰기 전까지 한국어만 사용한다.",
    ],
    soulTitle: "언어 정책",
    soulLines: [
      "감정 표현, 농담, 공감, 서술 톤까지 모두 한국어로 표현한다.",
      "메모나 원문이 다른 언어여도 응답 언어를 바꾸지 않는다.",
    ],
    agentsTitle: "응답 언어 계약",
    agentsLines: [
      "모든 직접 대화, 회의 발언, 태스크 보고, 요약, 후속 질문은 반드시 한국어로 작성한다.",
      "인간이 페르소나 문서를 의도적으로 다른 언어로 다시 작성하지 않는 한 이 규칙을 고정 규칙으로 취급한다.",
    ],
  },
  ja: {
    languageName: "日本語",
    identityTitle: "言語ポリシー",
    identityLines: [
      "現在の作業言語は日本語です。",
      "直接会話、会議での発言、タスク報告、要約、追加質問はすべて日本語で書きます。",
      "参照資料が別の言語でも、人間がこの方針を書き換えない限り、出力は日本語のみを使います。",
    ],
    soulTitle: "言語ポリシー",
    soulLines: [
      "感情表現、ユーモア、共感、語り口まで含めて日本語で表現します。",
      "メモや原文に別言語が含まれていても、応答言語は切り替えません。",
    ],
    agentsTitle: "応答言語ルール",
    agentsLines: [
      "すべての直接会話、会議ターン、タスク報告、要約、追加質問は必ず日本語で書きます。",
      "人間が意図的にペルソナ文書を別言語で書き直さない限り、このルールを固定ルールとして扱います。",
    ],
  },
  zh: {
    languageName: "中文",
    identityTitle: "语言策略",
    identityLines: [
      "当前工作语言为中文。",
      "直接对话、会议发言、任务汇报、总结和追问都必须使用中文。",
      "即使参考资料是其他语言，只要人类没有明确改写这条策略，你输出的内容也只能使用中文。",
    ],
    soulTitle: "语言策略",
    soulLines: [
      "情绪表达、幽默、共情和叙述语气都要用中文呈现。",
      "不要因为记忆或原文是其他语言就切换输出语言。",
    ],
    agentsTitle: "回复语言约束",
    agentsLines: [
      "所有直接聊天、会议轮次、任务汇报、总结和追问都必须使用中文。",
      "除非人类明确用其他语言重写这些人格文档，否则把这条规则视为强约束。",
    ],
  },
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSection(title: string, lines: string[]): string {
  return [`## ${title}`, "", ...lines.map((line) => `- ${line}`)].join("\n");
}

function stripManagedSection(text: string, titles: string[]): string {
  const titlePattern = titles.map(escapeRegExp).join("|");
  return text.replace(
    new RegExp(`\\n## (?:${titlePattern})[\\s\\S]*?(?=\\n## |\\n# |$)`, "g"),
    "",
  ).trim();
}

function insertSectionAfterHeading(text: string, section: string): string {
  const trimmed = text.trim();
  const headingMatch = trimmed.match(/^(# .+?)(\n+|$)/);

  if (!headingMatch) {
    return `${section}\n\n${trimmed}`.trim();
  }

  const insertIndex = headingMatch[0].length;
  return `${trimmed.slice(0, insertIndex)}\n${section}\n\n${trimmed.slice(insertIndex).trimStart()}`.trim();
}

export function localizeNpcPromptDocument(
  text: string,
  locale: string | null | undefined,
  document: PromptDocumentKind,
): string {
  const normalizedLocale = normalizeLocale(locale);
  const policy = LOCALE_POLICY_CONTENT[normalizedLocale];
  const section = document === "agents"
    ? buildSection(policy.agentsTitle, policy.agentsLines)
    : document === "soul"
      ? buildSection(policy.soulTitle, policy.soulLines)
      : buildSection(policy.identityTitle, policy.identityLines);
  const titles = document === "agents" ? RESPONSE_LANGUAGE_SECTION_TITLES : LANGUAGE_POLICY_SECTION_TITLES;
  const withoutManagedSection = stripManagedSection(text, titles);

  return insertSectionAfterHeading(withoutManagedSection, section);
}

export function hasNpcPresetDefaults(presetId: string | null | undefined): presetId is string {
  return !!presetId && OFFICE_PRESETS.some((candidate) => candidate.id === presetId);
}

function getMeetingProtocol(presetId: string, locale?: string): string {
  const personaPreset = PERSONA_PRESETS.find((candidate) => candidate.id === presetId);
  return localizeNpcPromptDocument(
    personaPreset?.meetingProtocol || PERSONA_PRESETS[0]?.meetingProtocol || "",
    locale,
    "agents",
  );
}

export function getDefaultMeetingProtocol(locale?: string): string {
  return getMeetingProtocol(PERSONA_PRESETS[0]?.id || "default", locale);
}

export function getDefaultAgentIdForPreset(presetId: string): string {
  return getOfficePresetOrThrow(presetId).id;
}

export function getNpcPresetDefaults(presetId: string, npcName: string): NpcPresetDefaults;
export function getNpcPresetDefaults(options: BuildNpcPresetDefaultsOptions): NpcPresetDefaults;
export function getNpcPresetDefaults(
  presetIdOrOptions: string | BuildNpcPresetDefaultsOptions,
  npcNameArg?: string,
): NpcPresetDefaults {
  const { presetId, npcName, locale } = typeof presetIdOrOptions === "string"
    ? { presetId: presetIdOrOptions, npcName: npcNameArg || "", locale: undefined }
    : presetIdOrOptions;
  const preset = getOfficePresetOrThrow(presetId);
  const resolvedName = npcName.trim() || preset.nameKo;

  return {
    presetId: preset.id,
    displayName: preset.nameKo,
    defaultAgentId: getDefaultAgentIdForPreset(presetId),
    appearance: {
      bodyType: preset.bodyType,
      layers: Object.fromEntries(
        Object.entries(preset.layers)
          .filter(([, value]) => value !== null)
          .map(([key, value]) => [key, { itemKey: value!.itemKey, variant: value!.variant }]),
      ),
    },
    identity: localizeNpcPromptDocument(applyPresetName(preset.identity, resolvedName), locale, "identity"),
    soul: localizeNpcPromptDocument(applyPresetName(preset.soul, resolvedName), locale, "soul"),
    meetingProtocol: getMeetingProtocol(presetId, locale),
  };
}

export function buildPersonaConfig({
  presetId,
  npcName,
  locale,
  identityOverride,
  soulOverride,
  fallbackPersona,
}: BuildPersonaConfigOptions) {
  const defaults = getNpcPresetDefaults({ presetId, npcName, locale });
  const identitySource = identityOverride?.trim() || fallbackPersona?.trim() || defaults.identity;
  const soulSource = soulOverride?.trim() || defaults.soul;

  return {
    identity: injectTaskPrompt(localizeNpcPromptDocument(identitySource, locale, "identity"), locale),
    soul: localizeNpcPromptDocument(soulSource, locale, "soul"),
  };
}

export function buildGatewayAgentFiles({
  presetId,
  npcName,
  locale,
  identityOverride,
  soulOverride,
  fallbackPersona,
}: BuildPersonaConfigOptions): GatewayAgentFile[] {
  const defaults = getNpcPresetDefaults({ presetId, npcName, locale });
  const personaConfig = buildPersonaConfig({
    presetId,
    npcName,
    locale,
    identityOverride,
    soulOverride,
    fallbackPersona,
  });

  return [
    { name: "IDENTITY.md", content: personaConfig.identity },
    { name: "SOUL.md", content: personaConfig.soul },
    { name: "AGENTS.md", content: defaults.meetingProtocol },
  ];
}
