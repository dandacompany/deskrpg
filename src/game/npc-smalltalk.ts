/** Local presentation only. Never emit these lines to sockets, chat, or AI history. */
import { normalizeLocale, type ServerLocale } from "@/lib/i18n/server";

export type SmalltalkLocale = ServerLocale;

/** Exchanges per viewer locale. Every locale has the same number of pairs, and each line names the partner once. */
export const SMALLTALK_LINES: Record<SmalltalkLocale, readonly (readonly [string, string])[]> = {
  ko: [
    ["{name}님, 좋은 하루예요!", "{name}님도 좋은 하루 보내세요!"],
    ["{name}님, 잠깐 스트레칭 어때요?", "좋아요, {name}님! 어깨 좀 풀어야겠어요."],
    ["{name}님, 커피 한 잔 하셨어요?", "아직요! {name}님 덕분에 생각났네요."],
    ["{name}님, 오늘도 반가워요!", "저도요, {name}님. 오늘도 힘내요!"],
    ["{name}님, 점심 맛있게 드셨어요?", "네! {name}님도 식사 잘 챙기세요."],
    ["{name}님, 잠깐 바람 쐬러 가세요?", "네, {name}님. 잠깐 걸으니 좋네요."],
    ["{name}님, 오늘 컨디션 어떠세요?", "좋아요! {name}님은 어떠세요?"],
    ["{name}님, 오늘도 수고 많으세요.", "고마워요, {name}님. 같이 힘내요!"],
    ["{name}님, 물 한 잔 챙기세요!", "감사해요, {name}님도요!"],
    ["{name}님, 잠깐 쉬어 가요.", "좋은 생각이에요, {name}님!"],
    ["{name}님, 창가 쪽이 참 좋네요.", "맞아요, {name}님. 눈도 잠깐 쉬어 가요."],
    ["{name}님, 오후도 파이팅이에요!", "{name}님도요! 천천히 하나씩 해봐요."],
    ["{name}님, 오늘 옷 멋지네요!", "고마워요, {name}님! 기분 좋네요."],
    ["{name}님, 간식 생각 안 나세요?", "마침 생각했어요, {name}님!"],
    ["{name}님, 산책하니 머리가 맑아져요.", "그러게요, {name}님. 좋은 휴식이네요."],
    ["{name}님, 반가워요. 잘 지내시죠?", "네, {name}님! 안부 고마워요."],
  ],
  en: [
    ["{name}, have a good day!", "You too, {name}!"],
    ["{name}, how about a quick stretch?", "Good idea, {name}! My shoulders need it."],
    ["{name}, had your coffee yet?", "Not yet! Thanks for the reminder, {name}."],
    ["{name}, good to see you again!", "You too, {name}. Let's do our best today!"],
    ["{name}, did you enjoy lunch?", "I did! Don't skip your meals either, {name}."],
    ["{name}, stepping out for some air?", "Yes, {name}. A short walk feels nice."],
    ["{name}, how are you feeling today?", "Great! How about you, {name}?"],
    ["{name}, thanks for all your hard work.", "Thank you, {name}. Let's keep at it together!"],
    ["{name}, remember to drink some water!", "Thanks, {name}, you too!"],
    ["{name}, let's take a short break.", "Good thinking, {name}!"],
    ["{name}, the window side is lovely.", "It is, {name}. Good for resting the eyes."],
    ["{name}, keep it up this afternoon!", "You too, {name}! One thing at a time."],
    ["{name}, nice outfit today!", "Thanks, {name}! That made my day."],
    ["{name}, craving a snack?", "I was just thinking that, {name}!"],
    ["{name}, a walk really clears the head.", "It does, {name}. A good break."],
    ["{name}, nice to see you. Doing well?", "Yes, {name}! Thanks for asking."],
  ],
  ja: [
    ["{name}さん、良い一日を！", "{name}さんも良い一日を！"],
    ["{name}さん、ちょっとストレッチしませんか？", "いいですね、{name}さん！肩をほぐさないと。"],
    ["{name}さん、コーヒーはもう飲みましたか？", "まだです！{name}さんのおかげで思い出しました。"],
    ["{name}さん、今日もよろしくお願いします！", "こちらこそ、{name}さん。今日も頑張りましょう！"],
    ["{name}さん、お昼はおいしかったですか？", "はい！{name}さんもちゃんと食べてくださいね。"],
    ["{name}さん、ちょっと外の空気を吸いに？", "はい、{name}さん。少し歩くと気持ちいいですね。"],
    ["{name}さん、今日の調子はどうですか？", "いいですよ！{name}さんはどうですか？"],
    [
      "{name}さん、今日もお疲れさまです。",
      "ありがとうございます、{name}さん。一緒に頑張りましょう！",
    ],
    ["{name}さん、お水も飲んでくださいね！", "ありがとうございます、{name}さんも！"],
    ["{name}さん、少し休憩しましょう。", "いい考えですね、{name}さん！"],
    ["{name}さん、窓際は気持ちいいですね。", "そうですね、{name}さん。目も少し休めましょう。"],
    ["{name}さん、午後も頑張りましょう！", "{name}さんも！一つずつやっていきましょう。"],
    ["{name}さん、今日の服すてきですね！", "ありがとうございます、{name}さん！うれしいです。"],
    ["{name}さん、おやつが欲しくなりませんか？", "ちょうど考えていました、{name}さん！"],
    ["{name}さん、散歩すると頭がすっきりしますね。", "本当ですね、{name}さん。いい休憩です。"],
    ["{name}さん、こんにちは。お元気ですか？", "はい、{name}さん！気にかけてくれてありがとう。"],
  ],
  zh: [
    ["{name}，祝你今天愉快！", "{name}，你也是！"],
    ["{name}，要不要伸展一下？", "好呀，{name}！肩膀正需要放松。"],
    ["{name}，喝过咖啡了吗？", "还没呢！多亏{name}提醒我。"],
    ["{name}，今天也很高兴见到你！", "我也是，{name}。今天也加油！"],
    ["{name}，午饭吃得好吗？", "很好！{name}也要好好吃饭哦。"],
    ["{name}，出去透透气吗？", "是的，{name}。走一走真舒服。"],
    ["{name}，今天状态怎么样？", "很好！{name}呢？"],
    ["{name}，今天也辛苦了。", "谢谢，{name}。一起加油！"],
    ["{name}，记得喝点水！", "谢谢，{name}也是！"],
    ["{name}，稍微休息一下吧。", "好主意，{name}！"],
    ["{name}，靠窗这边真不错。", "是啊，{name}。也让眼睛休息一下。"],
    ["{name}，下午也加油！", "{name}也是！一件一件慢慢来。"],
    ["{name}，今天的衣服真好看！", "谢谢，{name}！心情都变好了。"],
    ["{name}，想吃点零食吗？", "正想着呢，{name}！"],
    ["{name}，散散步脑子都清醒了。", "是啊，{name}。真是不错的休息。"],
    ["{name}，好久不见，最近好吗？", "很好，{name}！谢谢关心。"],
  ],
};
export type SmalltalkActor = {
  id: string;
  name: string;
  x: number;
  y: number;
  walking: boolean;
  available: boolean;
};
type Line = { text: string; start: number; end: number };
export const SMALLTALK_PAUSE_MS = 7500;
export class NpcSmalltalk {
  private lineSet: readonly (readonly [string, string])[];
  /** The viewer's display locale. Unknown or missing locales fall back to English. */
  constructor(locale?: string | null) {
    this.lineSet = SMALLTALK_LINES[normalizeLocale(locale)];
  }
  /** Switch the viewer's locale. Lines already on screen stay; the next exchange uses the new locale. */
  setLocale(locale: string | null | undefined) {
    this.lineSet = SMALLTALK_LINES[normalizeLocale(locale)];
  }
  private encounters = new Map<string, { partner: string; until: number }>();
  partner(id: string, now: number) {
    const encounter = this.encounters.get(id);
    return encounter && now < encounter.until ? encounter.partner : undefined;
  }
  private lines = new Map<string, Line>();
  private cooldown = new Map<string, number>();
  private pairs = new Map<string, number>();
  private nextEncounter = 0;
  private lastTemplate = -1;
  text(id: string, now: number) {
    const line = this.lines.get(id);
    return line && now >= line.start && now < line.end ? line.text : undefined;
  }
  update(
    actors: SmalltalkActor[],
    now: number,
    canSee: (a: SmalltalkActor, b: SmalltalkActor) => boolean,
    random = Math.random,
  ) {
    const available = new Set(actors.filter((a) => a.available).map((a) => a.id));
    for (const [id, encounter] of this.encounters) {
      if (now >= encounter.until || !available.has(id) || !available.has(encounter.partner)) {
        this.encounters.delete(id);
        this.encounters.delete(encounter.partner);
        this.lines.delete(id);
        this.lines.delete(encounter.partner);
      }
    }
    for (const [id, line] of this.lines)
      if (now >= line.end || !available.has(id)) this.lines.delete(id);
    if (now < this.nextEncounter) return;
    for (let i = 0; i < actors.length; i++)
      for (let j = i + 1; j < actors.length; j++) {
        const a = actors[i],
          b = actors[j];
        const key = JSON.stringify([a.id, b.id].sort());
        if (
          !a.available ||
          !b.available ||
          !(a.walking || b.walking) ||
          Math.hypot(a.x - b.x, a.y - b.y) > 1.8 ||
          now < (this.cooldown.get(a.id) ?? 0) ||
          now < (this.cooldown.get(b.id) ?? 0) ||
          now < (this.pairs.get(key) ?? 0) ||
          !canSee(a, b)
        )
          continue;
        // Select uniformly from all templates except the previous exchange.
        let index = Math.floor(random() * (this.lineSet.length - (this.lastTemplate >= 0 ? 1 : 0)));
        if (this.lastTemplate >= 0 && index >= this.lastTemplate) index++;
        this.lastTemplate = index;
        const name = (value: string) => value.split(/\s*[·|]\s*/)[0].trim();
        this.lines.set(a.id, {
          text: this.lineSet[index][0].replace("{name}", name(b.name)),
          start: now,
          end: now + 4500,
        });
        this.lines.set(b.id, {
          text: this.lineSet[index][1].replace("{name}", name(a.name)),
          start: now + 2000,
          end: now + 6500,
        });
        this.encounters.set(a.id, { partner: b.id, until: now + SMALLTALK_PAUSE_MS });
        this.encounters.set(b.id, { partner: a.id, until: now + SMALLTALK_PAUSE_MS });
        this.cooldown.set(a.id, now + 45000);
        this.cooldown.set(b.id, now + 45000);
        this.pairs.set(key, now + 90000);
        this.nextEncounter = now + 12000;
        return;
      }
  }
}
