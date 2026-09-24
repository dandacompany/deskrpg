import type { CharacterAppearance } from "./office-appearance";
import { EXTENDED_OFFICE_LOOKS } from "./office-looks-extended";

export type OfficeLook = {
  id: string;
  name: string;
  nameEn: string;
  category: "classic" | "casual" | "creative" | "leadership";
  subtitle: string;
  subtitleEn: string;
  skin: string;
  skinVariant: string;
  hair: string;
  hairStyle: "part" | "bob" | "pony" | "curls" | "wave" | "crop" | "bun" | "long" | "braids";
  outfit:
    | "suit"
    | "shirt"
    | "vest"
    | "blouse"
    | "coat"
    | "cardigan"
    | "double-breasted"
    | "hoodie"
    | "labcoat";
  coat: string;
  shirt: string;
  trousers: string;
  shoes: string;
  tie?: string;
  glasses?: boolean;
  bag?: "briefcase" | "shoulder" | "backpack";
  neckwear?: "bow" | "scarf" | "turtleneck";
  accessory?: "badge" | "headset" | "notebook";
  skirtLength?: "knee" | "long";
  lower?: "wide" | "skirt";
  pattern?: "check" | "pinstripe" | "knit";
  build: number;
  stance: "composed" | "relaxed" | "bright";
  bodyType: "male" | "female";
};

export const LOOK_CATEGORIES = [
  { id: "all", ko: "전체", en: "All" },
  { id: "classic", ko: "클래식 수트", en: "Classic suits" },
  { id: "casual", ko: "비즈니스 캐주얼", en: "Business casual" },
  { id: "creative", ko: "크리에이티브", en: "Creative" },
  { id: "leadership", ko: "리더십", en: "Leadership" },
] as const;

/** Stable IDs are saved in appearance JSON. Never repurpose an existing ID. */
export const OFFICE_LOOKS: readonly OfficeLook[] = [
  {
    id: "office-jun",
    name: "서준",
    nameEn: "Jun",
    category: "classic",
    subtitle: "첫 출근의 설렘 · 네이비 수트와 사원증",
    subtitleEn: "First day · navy suit and ID badge",
    skin: "#e9b88e",
    skinVariant: "light",
    hair: "#302b28",
    hairStyle: "part",
    outfit: "suit",
    coat: "#293c55",
    shirt: "#f7f1e6",
    trousers: "#293c55",
    shoes: "#302d2a",
    tie: "#819bae",
    bag: "shoulder",
    build: 0.94,
    stance: "composed",
    bodyType: "male",
  },
  {
    id: "office-tae",
    name: "태오",
    nameEn: "Tae",
    category: "casual",
    subtitle: "현장을 아는 베테랑 · 셔츠와 느슨한 타이",
    subtitleEn: "Seasoned colleague · rolled sleeves and loose tie",
    skin: "#ba855f",
    skinVariant: "bronze",
    hair: "#403b37",
    hairStyle: "wave",
    outfit: "shirt",
    coat: "#d8e0e0",
    shirt: "#d8e0e0",
    trousers: "#525652",
    shoes: "#38352f",
    tie: "#596d76",
    build: 1.13,
    stance: "relaxed",
    bodyType: "male",
  },
  {
    id: "office-seo",
    name: "서린",
    nameEn: "Seorin",
    category: "classic",
    subtitle: "차분한 추진력 · 차콜 수트와 포니테일",
    subtitleEn: "Quiet confidence · charcoal suit and ponytail",
    skin: "#f0c6a2",
    skinVariant: "light",
    hair: "#332720",
    hairStyle: "pony",
    outfit: "suit",
    coat: "#454b4c",
    shirt: "#dce4e4",
    trousers: "#454b4c",
    shoes: "#2d3031",
    build: 0.91,
    stance: "composed",
    bodyType: "female",
  },
  {
    id: "office-min",
    name: "민재",
    nameEn: "Minjae",
    category: "classic",
    subtitle: "정돈된 취향 · 체크 수트와 둥근 안경",
    subtitleEn: "Considered details · checked suit and round glasses",
    skin: "#bd906c",
    skinVariant: "olive",
    hair: "#292c2b",
    hairStyle: "crop",
    outfit: "suit",
    coat: "#756a59",
    shirt: "#f5eee0",
    trousers: "#756a59",
    shoes: "#45372c",
    tie: "#9d6545",
    glasses: true,
    pattern: "check",
    build: 1,
    stance: "bright",
    bodyType: "male",
  },
  {
    id: "office-do",
    name: "도윤",
    nameEn: "Doyun",
    category: "casual",
    subtitle: "든든한 동료 · 니트 베스트와 셔츠",
    subtitleEn: "A steady presence · knit vest and shirt",
    skin: "#aa7454",
    skinVariant: "brown",
    hair: "#403b34",
    hairStyle: "curls",
    outfit: "vest",
    coat: "#616d61",
    shirt: "#deddd1",
    trousers: "#565a50",
    shoes: "#493c30",
    glasses: true,
    pattern: "knit",
    build: 1.27,
    stance: "relaxed",
    bodyType: "male",
  },
  {
    id: "office-yun",
    name: "윤서",
    nameEn: "Yunseo",
    category: "leadership",
    subtitle: "단단한 리더 · 네이비 재킷과 와이드 팬츠",
    subtitleEn: "A grounded leader · navy jacket and wide trousers",
    skin: "#805338",
    skinVariant: "black",
    hair: "#242423",
    hairStyle: "wave",
    outfit: "suit",
    coat: "#354455",
    shirt: "#f0e2cb",
    trousers: "#354455",
    shoes: "#40352f",
    lower: "wide",
    bag: "briefcase",
    build: 1.04,
    stance: "composed",
    bodyType: "female",
  },
  {
    id: "office-ha",
    name: "하경",
    nameEn: "Hakyung",
    category: "creative",
    subtitle: "선명한 아이디어 · 머스터드 니트와 와이드 팬츠",
    subtitleEn: "Bright ideas · mustard knit and wide trousers",
    skin: "#d2a77f",
    skinVariant: "olive",
    hair: "#4e392e",
    hairStyle: "curls",
    outfit: "blouse",
    coat: "#bf9344",
    shirt: "#bf9344",
    trousers: "#827c66",
    shoes: "#46413b",
    lower: "wide",
    build: 0.98,
    stance: "bright",
    bodyType: "female",
  },
  {
    id: "office-jin",
    name: "진우",
    nameEn: "Jinwoo",
    category: "creative",
    subtitle: "책을 만드는 사람 · 카멜 코트와 터틀넥",
    subtitleEn: "An editorial eye · camel coat and turtleneck",
    skin: "#edc7aa",
    skinVariant: "light",
    hair: "#43382d",
    hairStyle: "wave",
    outfit: "coat",
    coat: "#b38c5f",
    shirt: "#333634",
    trousers: "#454a48",
    shoes: "#39342e",
    bag: "briefcase",
    build: 0.96,
    stance: "relaxed",
    bodyType: "male",
  },
  {
    id: "office-eun",
    name: "은채",
    nameEn: "Eunchae",
    category: "casual",
    subtitle: "따뜻한 집중력 · 카디건과 플리츠 롱스커트",
    subtitleEn: "Warm focus · cardigan and pleated long skirt",
    skin: "#d6a180",
    skinVariant: "bronze",
    hair: "#594236",
    hairStyle: "bob",
    outfit: "cardigan",
    coat: "#ddd0b5",
    shirt: "#ece2ce",
    trousers: "#545e57",
    shoes: "#634b3b",
    lower: "skirt",
    bag: "shoulder",
    pattern: "knit",
    build: 1.04,
    stance: "bright",
    bodyType: "female",
  },
  {
    id: "office-hyeon",
    name: "현진",
    nameEn: "Hyeonjin",
    category: "leadership",
    subtitle: "경험이 만든 여유 · 실버 헤어와 다크 쓰리피스",
    subtitleEn: "Seasoned perspective · silver hair and dark three-piece",
    skin: "#a77656",
    skinVariant: "brown",
    hair: "#c7c6bf",
    hairStyle: "part",
    outfit: "suit",
    coat: "#303f47",
    shirt: "#d6e0de",
    trousers: "#303f47",
    shoes: "#30302c",
    tie: "#4d6965",
    glasses: true,
    pattern: "pinstripe",
    build: 1.08,
    stance: "composed",
    bodyType: "male",
  },
  ...EXTENDED_OFFICE_LOOKS,
];

export function resolveOfficeLook(appearance: unknown): OfficeLook | undefined {
  if (typeof appearance === "string") {
    try {
      appearance = JSON.parse(appearance);
    } catch {
      return undefined;
    }
  }
  if (!appearance || typeof appearance !== "object") return undefined;
  const id = (appearance as { officeLookId?: unknown }).officeLookId;
  return OFFICE_LOOKS.find((look) => look.id === id);
}

export function officeLookAppearance(id: string): CharacterAppearance {
  const look = OFFICE_LOOKS.find((candidate) => candidate.id === id);
  if (!look) throw new Error(`Unknown office look: ${id}`);
  // The canonical form is only the two keys — layer data is no longer built.
  return { officeLookId: look.id, bodyType: look.bodyType };
}
