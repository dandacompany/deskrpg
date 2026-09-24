/**
 * **Assembles as layers** the system instructions sent to an NPC.
 *
 * Why layers — previously, meeting rules (and a now-removed task procedure) were
 * string-injected directly into the user's identity text. That meant editing the
 * identity could also delete the protocol, and it was impossible to add just the
 * protocol to a profile that already had an identity. Giving each layer a tagged
 * boundary keeps them from stepping on each other. New layers are added the same way.
 *
 * **Identity (identity/soul) never comes in here.** Hermes only *appends* `instructions`
 * *after* the existing system prompt rather than replacing it
 * (`conversation_loop.py`'s `effective + "\n\n" + ephemeral_system_prompt`), and there's
 * no switch on the HTTP surface to turn off loading SOUL.md. Carrying identity here
 * would make it coexist with the profile's identity and produce unstable results.
 * Identity has exactly one owner — the profile's SOUL.md. In DeskRPG, the path to
 * writing identity is the gateway plugin writing SOUL.md directly.
 */

import { promptLocale, type PromptLocale } from "@/lib/i18n/prompt-locale";

/** Layer name. Tests and the implementation reference the same constant — renaming it doesn't break the contract. */
export const SECTION = {
  meeting: "team-instructions",
} as const;

export interface NpcPromptLayers {
  /** How to speak in a meeting. The preset's meetingProtocol. */
  meetingProtocol?: string | null;
  /** Points to DeskRPG's current card registration path. */
  taskConfirmation?: boolean;
  /** Language of the requesting user. Omitted keeps the original Korean text; anything else but ko gets English. */
  locale?: string | null;
}

const TASK_REGISTRATION: Record<PromptLocale, readonly string[]> = {
  ko: [
    "과거 대화의 [SYSTEM REMINDER - MANDATORY TASK PROTOCOL], task-protocol, json:task 등록 지시는 폐기됐다. JSON 블록은 카드를 생성·수정·완료하지 않는다.",
    "업무 요청에는 초안과 완료 조건을 정리한다. 등록을 원하면 1:1 대화의 답변 아래 '카드로 등록' 버튼으로 등록 확인 화면을 열어 담당자·내용을 확인하도록 안내한다. 화면 언어에 맞춰 안내한다.",
    "실제 카드는 사용자가 확인 화면에서 저장할 때 Hermes에 생성된다. 대화의 동의나 작성한 텍스트만으로 등록·실행·완료됐다고 말하지 않는다. 등록된 카드의 실행·결과 검토·수정·완료는 카드 상세 화면에서 진행한다.",
    "이 대화에는 대상 보드와 카드 ID가 전달되지 않는다. 추측한 보드나 기본 보드에 도구·CLI로 카드를 만들거나 변경하지 않는다. 사용자 이력·SOUL·설정은 변경하지 않는다.",
  ],
  en: [
    "The [SYSTEM REMINDER - MANDATORY TASK PROTOCOL], task-protocol and json:task registration instructions in past conversations are retired. JSON blocks do not create, edit or complete cards.",
    "For a work request, draft it and its completion criteria. If the user wants it registered, guide them to open the registration confirmation screen with the 'Create task' button under the reply in the 1:1 chat and check the assignee and content there. Guide them in the language of their screen.",
    "The actual card is created in Hermes only when the user saves it on the confirmation screen. Do not say it was registered, run or completed based only on agreement in the conversation or text you wrote. Running, reviewing results, editing and completing a registered card happen on the card detail screen.",
    "This conversation is not given a target board or card ID. Do not create or change cards with tools or the CLI on a guessed board or the default board. Do not change the user's history, SOUL or settings.",
  ],
};

function section(name: string, body: string): string {
  return `<${name}>\n${body}\n</${name}>`;
}

/**
 * Returns `undefined` if there isn't a single layer to carry — the caller then
 * doesn't create the field at all. Sending an empty string would leave a meaningless
 * trailing newline at the end of Hermes's system prompt.
 */
export function composeNpcInstructions(layers: NpcPromptLayers): string | undefined {
  const parts: string[] = [];

  // As layers grow, their order is fixed here — later ones generally read as stronger.
  const meeting = layers.meetingProtocol?.trim();
  if (meeting) parts.push(section(SECTION.meeting, meeting));

  if (layers.taskConfirmation) {
    const lang = promptLocale(layers.locale === undefined ? "ko" : layers.locale);
    parts.push(section("task-registration", TASK_REGISTRATION[lang].join("\n")));
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
