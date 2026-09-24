import { normalizeLocale, type ServerLocale } from "@/lib/i18n/server";
import { LOOK_CATEGORIES, OFFICE_LOOKS, type OfficeLook } from "./office-looks";

export type LookLabel = { name: string; subtitle: string };
type LookCategoryId = (typeof LOOK_CATEGORIES)[number]["id"];

/**
 * ja/zh display labels by look id. ko and en live on the look itself (`name`/`subtitle`, `nameEn`/`subtitleEn`).
 * Chinese keeps the romanized name: the characters are Korean given names with no fixed hanzi.
 */
const LOOK_LABELS: Record<"ja" | "zh", Record<string, LookLabel>> = {
  ja: {
    "office-jun": { name: "ソジュン", subtitle: "初出勤の高揚 · ネイビースーツと社員証" },
    "office-tae": { name: "テオ", subtitle: "現場を知るベテラン · シャツと緩めたネクタイ" },
    "office-seo": { name: "ソリン", subtitle: "落ち着いた推進力 · チャコールスーツとポニーテール" },
    "office-min": { name: "ミンジェ", subtitle: "整ったこだわり · チェックスーツと丸眼鏡" },
    "office-do": { name: "ドユン", subtitle: "頼れる同僚 · ニットベストとシャツ" },
    "office-yun": {
      name: "ユンソ",
      subtitle: "芯のあるリーダー · ネイビージャケットとワイドパンツ",
    },
    "office-ha": {
      name: "ハギョン",
      subtitle: "鮮やかなアイデア · マスタードニットとワイドパンツ",
    },
    "office-jin": { name: "ジヌ", subtitle: "本をつくる人 · キャメルコートとタートルネック" },
    "office-eun": {
      name: "ウンチェ",
      subtitle: "温かな集中力 · カーディガンとプリーツロングスカート",
    },
    "office-hyeon": {
      name: "ヒョンジン",
      subtitle: "経験が生む余裕 · シルバーヘアとダークスリーピース",
    },
    "office-nari": { name: "ナリ", subtitle: "広告プランナー · リボンブラウスと膝丈スカート" },
    "office-roan": {
      name: "ロアン",
      subtitle: "アートディレクター · 黒のタートルネックとチェックコート",
    },
    "office-soi": {
      name: "ソイ",
      subtitle: "ブランドストラテジスト · アップヘアとダブルジャケット",
    },
    "office-yul": { name: "ユル", subtitle: "コピーライター · 巻き毛とニットベスト" },
    "office-bomi": {
      name: "ボミ",
      subtitle: "コンテンツプロデューサー · 三つ編みとロングスカート",
    },
    "office-jiho": { name: "ジホ", subtitle: "撮影監督 · シャツと現場用ヘッドセット" },
    "office-dami": { name: "ダミ", subtitle: "キャンペーンマネージャー · スカーフと短いボブ" },
    "office-seul": { name: "スラ", subtitle: "デザインリサーチャー · ロングヘアとゆったりニット" },
    "office-kyu": {
      name: "ギュミン",
      subtitle: "クライアントパートナー · ストライプスーツとネクタイ",
    },
    "office-ara": {
      name: "アラ",
      subtitle: "イベントディレクター · ポニーテールと動きやすいベスト",
    },
    "office-ian": { name: "イアン", subtitle: "バックエンド開発者 · 眼鏡とジップパーカー" },
    "office-rumi": { name: "ルミ", subtitle: "フロントエンド開発者 · 三つ編みとパーカー" },
    "office-gonu": { name: "ゴヌ", subtitle: "QAエンジニア · チェックシャツと記録ノート" },
    "office-haena": { name: "ヘナ", subtitle: "データサイエンティスト · 白衣とアップヘア" },
    "office-woojin": { name: "ウジン", subtitle: "社内IT担当 · 巻き毛とワイドパンツ" },
    "office-jua": { name: "ジュア", subtitle: "UXデザイナー · ウェーブヘアとリボンニット" },
    "office-taemin": { name: "テミン", subtitle: "スクラムマスター · ベストと社員証" },
    "office-sera": {
      name: "セラ",
      subtitle: "セキュリティエンジニア · ロングヘアとタートルネックコート",
    },
    "office-hosu": { name: "ホス", subtitle: "ロボット研究員 · 短髪と白衣" },
    "office-yena": {
      name: "イェナ",
      subtitle: "コミュニティマネージャー · ボブとゆったりパーカー",
    },
    "office-sungho": { name: "ソンホ", subtitle: "運営統括 · シルバーの分け髪とダブルスーツ" },
    "office-hyejin": { name: "ヘジン", subtitle: "財務責任者 · アップヘアと落ち着いたスカーフ" },
    "office-jungwon": { name: "ジョンウォン", subtitle: "人事責任者 · 銀色のボブとロングニット" },
    "office-seok": { name: "ソッキョン", subtitle: "事業代表 · ウェーブヘアとチェックスーツ" },
    "office-mira": { name: "ミラ", subtitle: "クリエイティブ統括 · ロングヘアとダブルジャケット" },
    "office-kyung": { name: "ギョンス", subtitle: "法務責任者 · 整えた髪とスリーピース" },
    "office-yeon": { name: "ヨンファ", subtitle: "取締役会議長 · シルバーのアップヘアとコート" },
    "office-dohun": { name: "ドフン", subtitle: "創業者 · 巻き毛と実用的なパーカー" },
    "office-suhye": { name: "スヘ", subtitle: "営業統括 · ポニーテールと鮮やかなスーツ" },
    "office-jaewon": { name: "ジェウォン", subtitle: "戦略顧問 · 銀色のウェーブとタートルネック" },
    "office-daeun": { name: "ダウン", subtitle: "文芸編集者 · ロングヘアとロングスカート" },
    "office-jiseok": { name: "ジソク", subtitle: "翻訳編集者 · 巻き毛とチェックベスト" },
    "office-seona": { name: "ソナ", subtitle: "ブックデザイナー · 三つ編みとアトリエコート" },
    "office-haram": { name: "ハラム", subtitle: "海外版権担当 · スカーフとダブルスーツ" },
    "office-chan": { name: "チャニョン", subtitle: "制作管理 · シャツと工房の社員証" },
    "office-eunsol": {
      name: "ウンソル",
      subtitle: "校正・校閲者 · アップヘアとニットカーディガン",
    },
    "office-sejin": { name: "セジン", subtitle: "交渉の専門家 · 分け髪とピンストライプ" },
    "office-hyo": { name: "ヒョジュ", subtitle: "書店営業 · 短いボブと楽なベスト" },
    "office-yumin": {
      name: "ユミン",
      subtitle: "パートナーシップマネージャー · ウェーブとノーネクタイのスーツ",
    },
    "office-garam": { name: "ガラム", subtitle: "作家マネージャー · ポニーテールとゆったりコート" },
  },
  zh: {
    "office-jun": { name: "Jun", subtitle: "初次上班的期待 · 藏青西装与工牌" },
    "office-tae": { name: "Tae", subtitle: "懂现场的老手 · 衬衫与松开的领带" },
    "office-seo": { name: "Seorin", subtitle: "沉稳的推动力 · 炭灰西装与马尾" },
    "office-min": { name: "Minjae", subtitle: "讲究的品味 · 格纹西装与圆框眼镜" },
    "office-do": { name: "Doyun", subtitle: "可靠的同事 · 针织背心与衬衫" },
    "office-yun": { name: "Yunseo", subtitle: "坚定的领导者 · 藏青外套与阔腿裤" },
    "office-ha": { name: "Hakyung", subtitle: "鲜明的创意 · 芥末黄针织衫与阔腿裤" },
    "office-jin": { name: "Jinwoo", subtitle: "做书的人 · 驼色大衣与高领衫" },
    "office-eun": { name: "Eunchae", subtitle: "温暖的专注 · 开衫与百褶长裙" },
    "office-hyeon": { name: "Hyeonjin", subtitle: "阅历带来的从容 · 银发与深色三件套" },
    "office-nari": { name: "Nari", subtitle: "广告策划 · 蝴蝶结衬衫与及膝裙" },
    "office-roan": { name: "Roan", subtitle: "艺术总监 · 黑色高领衫与格纹大衣" },
    "office-soi": { name: "Soi", subtitle: "品牌策略师 · 盘发与双排扣外套" },
    "office-yul": { name: "Yul", subtitle: "文案 · 卷发与针织背心" },
    "office-bomi": { name: "Bomi", subtitle: "内容制作人 · 麻花辫与长裙" },
    "office-jiho": { name: "Jiho", subtitle: "摄影指导 · 衬衫与现场耳机" },
    "office-dami": { name: "Dami", subtitle: "活动经理 · 丝巾与短波波头" },
    "office-seul": { name: "Seula", subtitle: "设计研究员 · 长发与宽松针织衫" },
    "office-kyu": { name: "Kyumin", subtitle: "客户合伙人 · 条纹西装与领带" },
    "office-ara": { name: "Ara", subtitle: "活动总监 · 马尾与利落背心" },
    "office-ian": { name: "Ian", subtitle: "后端工程师 · 眼镜与拉链连帽衫" },
    "office-rumi": { name: "Rumi", subtitle: "前端工程师 · 麻花辫与连帽衫" },
    "office-gonu": { name: "Gonu", subtitle: "QA 工程师 · 格子衬衫与记录本" },
    "office-haena": { name: "Haena", subtitle: "数据科学家 · 实验服与盘发" },
    "office-woojin": { name: "Woojin", subtitle: "公司 IT 专员 · 卷发与阔腿裤" },
    "office-jua": { name: "Jua", subtitle: "UX 设计师 · 波浪发与蝴蝶结针织衫" },
    "office-taemin": { name: "Taemin", subtitle: "Scrum Master · 背心与工牌" },
    "office-sera": { name: "Sera", subtitle: "安全工程师 · 长发与高领大衣" },
    "office-hosu": { name: "Hosu", subtitle: "机器人研究员 · 短发与实验服" },
    "office-yena": { name: "Yena", subtitle: "社区经理 · 波波头与宽松连帽衫" },
    "office-sungho": { name: "Sungho", subtitle: "运营总监 · 银色分头与双排扣西装" },
    "office-hyejin": { name: "Hyejin", subtitle: "财务负责人 · 盘发与素雅丝巾" },
    "office-jungwon": { name: "Jungwon", subtitle: "人事负责人 · 银色波波头与长款针织衫" },
    "office-seok": { name: "Seokhyun", subtitle: "业务总裁 · 波浪发与格纹西装" },
    "office-mira": { name: "Mira", subtitle: "创意总监 · 长发与双排扣外套" },
    "office-kyung": { name: "Kyungsu", subtitle: "法务负责人 · 利落发型与三件套" },
    "office-yeon": { name: "Yeonhwa", subtitle: "董事会主席 · 银色盘发与大衣" },
    "office-dohun": { name: "Dohun", subtitle: "创始人 · 卷发与实用连帽衫" },
    "office-suhye": { name: "Suhye", subtitle: "销售总监 · 马尾与醒目西装" },
    "office-jaewon": { name: "Jaewon", subtitle: "战略顾问 · 银色波浪发与高领衫" },
    "office-daeun": { name: "Daeun", subtitle: "文学编辑 · 长发与长裙" },
    "office-jiseok": { name: "Jiseok", subtitle: "翻译编辑 · 卷发与格纹背心" },
    "office-seona": { name: "Seona", subtitle: "书籍设计师 · 麻花辫与工作室大衣" },
    "office-haram": { name: "Haram", subtitle: "海外版权负责人 · 丝巾与双排扣西装" },
    "office-chan": { name: "Chanyoung", subtitle: "印制管理 · 衬衫与工坊工牌" },
    "office-eunsol": { name: "Eunsol", subtitle: "校对编辑 · 盘发与针织开衫" },
    "office-sejin": { name: "Sejin", subtitle: "谈判专家 · 侧分发与细条纹" },
    "office-hyo": { name: "Hyoju", subtitle: "书店销售 · 短波波头与轻便背心" },
    "office-yumin": { name: "Yumin", subtitle: "合作经理 · 波浪发与无领带西装" },
    "office-garam": { name: "Garam", subtitle: "作者经纪 · 马尾与宽松大衣" },
  },
};

const CATEGORY_LABELS: Record<"ja" | "zh", Record<LookCategoryId, string>> = {
  ja: {
    all: "すべて",
    classic: "クラシックスーツ",
    casual: "ビジネスカジュアル",
    creative: "クリエイティブ",
    leadership: "リーダーシップ",
  },
  zh: {
    all: "全部",
    classic: "经典西装",
    casual: "商务休闲",
    creative: "创意",
    leadership: "领导层",
  },
};

/** The only way to pick a look's display name and subtitle. Unknown locales fall back to English. */
export function lookLabel(look: OfficeLook, locale: string | null | undefined): LookLabel {
  const lang: ServerLocale = normalizeLocale(locale);
  if (lang === "ko") return { name: look.name, subtitle: look.subtitle };
  if (lang === "en") return { name: look.nameEn, subtitle: look.subtitleEn };
  return LOOK_LABELS[lang][look.id] ?? { name: look.nameEn, subtitle: look.subtitleEn };
}

/** The outfit half of the subtitle ("role · outfit" → "outfit"). */
export function lookOutfit(look: OfficeLook, locale: string | null | undefined): string {
  const { subtitle } = lookLabel(look, locale);
  return subtitle.split(" · ")[1] ?? subtitle;
}

export function lookCategoryLabel(id: LookCategoryId, locale: string | null | undefined): string {
  const lang = normalizeLocale(locale);
  const category = LOOK_CATEGORIES.find((c) => c.id === id)!;
  if (lang === "ko") return category.ko;
  if (lang === "en") return category.en;
  return CATEGORY_LABELS[lang][id];
}

/** Search text across all four languages, so a name typed in any language finds the look on any screen. */
export function lookSearchText(look: OfficeLook): string {
  const parts = [look.name, look.subtitle, look.nameEn, look.subtitleEn];
  for (const lang of ["ja", "zh"] as const) {
    const label = LOOK_LABELS[lang][look.id];
    if (label) parts.push(label.name, label.subtitle);
  }
  return parts.join(" ").toLowerCase();
}

/** Ids without ja/zh labels. Exported for the completeness test. */
export function looksMissingLabels(): string[] {
  return OFFICE_LOOKS.filter((l) => !LOOK_LABELS.ja[l.id] || !LOOK_LABELS.zh[l.id]).map(
    (l) => l.id,
  );
}
