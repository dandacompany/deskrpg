/** An NPC question as the screen sees it — shared by the server (`npc-questions.ts`) and client components. */
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
