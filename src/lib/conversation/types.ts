// Types shared by conversation runtime pieces.
//
// This file exists because of a single dependency direction. `EngineParticipant`
// originally lived in `channel-runtime.ts`, and `npc-runtime.ts` imported it from there —
// but `channel-runtime` uses `npc-runtime` as a value, so the child ends up pointing back
// at its parent. `import type` is erased at compile time so it isn't a runtime cycle, but
// adding even one value import later would turn it into a real cycle that shows up as an
// initialization-order bug — the kind where it takes a long time to trace the cause back
// to that one line.
//
// Why it's not placed next to `turn-policy.ts`: that file declares itself as "a pure
// function — no I/O, knows nothing about adapters, sockets, or the DB." A type that
// carries an adapter would break that contract.

import type { NpcAdapter } from "@/lib/adapters/types";
import type { Participant } from "./turn-policy";

export type EngineParticipant = Participant & {
  adapter: NpcAdapter;
  sessionKey: string;
  /** Carried in the speaking prompt's participant list as `name(role)`. Omitted, it falls back to "Participant". */
  role?: string | null;
  /** Carried in the polling prompt's `[speaking guidance]` block (meeting-formatter.js:30-32). The old broker
   * passed agent.passPolicy through as-is (meeting-broker.js:307) — the block itself is omitted if there's no value. */
  passPolicy?: string | null;
  /**
   * The system instructions to carry in this NPC's turn (the result of `composeNpcInstructions()`).
   * The same value must be carried on **both** the poll and the speaking turn — carrying
   * it on only one means the same NPC gets different rules when raising its hand versus when speaking.
   */
  instructions?: string | null;
};
