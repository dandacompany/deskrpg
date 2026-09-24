import { normalizeLocale } from "../../lib/i18n/server";

type Translations = { en: string; ja: string; zh: string };

/**
 * Room and zone labels are authored in Korean on the layout data (`label`); this maps each one to the other
 * locales. Keyed by the Korean label because several environments share a label for different room ids.
 */
const ROOM_LABELS: Record<string, Translations> = {
  대표실: { en: "CEO office", ja: "代表室", zh: "总经理室" },
  미팅룸: { en: "Meeting room", ja: "ミーティングルーム", zh: "会议室" },
  탕비실: { en: "Pantry", ja: "給湯室", zh: "茶水间" },
  "대표 업무석": { en: "CEO desk", ja: "代表の執務席", zh: "总经理办公位" },
  "라운드 미팅": { en: "Round meeting", ja: "ラウンドミーティング", zh: "圆桌会议" },
  "응접 라운지": { en: "Reception lounge", ja: "応接ラウンジ", zh: "接待休息区" },
  "포토 베이": { en: "Photo bay", ja: "フォトベイ", zh: "摄影区" },
  워크스테이션: { en: "Workstations", ja: "ワークステーション", zh: "工作站" },
  "아이디어 공간": { en: "Ideation space", ja: "アイデアスペース", zh: "创意空间" },
  "메인 라운지": { en: "Main lounge", ja: "メインラウンジ", zh: "主休息区" },
  "제작 공간": { en: "Production space", ja: "制作スペース", zh: "制作空间" },
  "스튜디오 대표실": { en: "Studio director's office", ja: "スタジオ代表室", zh: "工作室总监室" },
  팬트리: { en: "Pantry", ja: "パントリー", zh: "茶水间" },
  "작은 라운지": { en: "Small lounge", ja: "小ラウンジ", zh: "小休息区" },
};

/** The only way to pick a room label for display. Unknown labels and locales fall back to the authored label / English. */
export function roomLabel(label: string, locale: string | null | undefined): string {
  const lang = normalizeLocale(locale);
  if (lang === "ko") return label;
  return ROOM_LABELS[label]?.[lang] ?? label;
}

/** Korean labels with no translation. Exported for the completeness test. */
export function untranslatedRoomLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => !ROOM_LABELS[label]);
}
