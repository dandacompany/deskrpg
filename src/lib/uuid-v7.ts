// UUIDv7 (RFC 9562 §5.7) — the leading 48 bits are Unix milliseconds, so **string sort
// order is generation order**.
//
// Why this is needed: while `chat_room_messages.id` was v4 (random), code that broke a
// `created_at` tie using the id picked the winner at random. `created_at` is a
// millisecond string in SQLite, so rows arriving in the same millisecond are common
// (true not just in tests but also when NPC replies finish simultaneously).
// As a result, "the most recent N rows" and "the room's last message" changed on every call.
//
// Node 22 has no built-in UUIDv7, so we build it ourselves. Nothing but `node:crypto` is used.

import { randomFillSync } from "node:crypto";

/** The last timestamp written (ms). If the clock goes backward, it stays pinned here. */
let lastMs = 0;
/**
 * Uses `rand_a` (12 bits) as a **monotonically increasing counter** within the same
 * millisecond — a fixed-length variant of RFC 9562 §6.2 "Monotonic Random". These 12 bits
 * sit right after the version nibble and before the random tail, so bumping the counter
 * alone increases the whole string.
 *
 * Guaranteed **only within a single process**. If multiple processes write to the same room
 * in the same millisecond, the order between them is random again — catching that case
 * would need a DB sequence. What this fully makes deterministic is the problem we actually
 * had: "rows inserted back-to-back by one process".
 */
let counter = 0;
const COUNTER_MAX = 0xfff;

const bytes = new Uint8Array(16);
const HEX: string[] = [];
for (let i = 0; i < 256; i += 1) HEX.push(i.toString(16).padStart(2, "0"));

export function uuidv7(): string {
  // If the clock goes backward, stay at the last value — writing a rewound timestamp would break sort order.
  const now = Math.max(Date.now(), lastMs);

  if (now === lastMs) {
    counter += 1;
    if (counter > COUNTER_MAX) {
      // Exceeded 4096 in one millisecond. Borrow the next millisecond early and reset the counter.
      lastMs = now + 1;
      counter = 0;
    }
  } else {
    lastMs = now;
    // A new millisecond starts from a low random number, not 0 — this reduces predictable ids
    // while still leaving more than half of the 4096-slot headroom.
    counter = randomFillSync(new Uint8Array(1))[0] & 0x3ff;
  }

  const ms = lastMs;
  // 48-bit timestamp. `>>>` only works on 32 bits, so the upper 16 bits are extracted via division.
  const msHigh = Math.floor(ms / 0x1_0000_0000);
  const msLow = ms % 0x1_0000_0000;
  bytes[0] = (msHigh >>> 8) & 0xff;
  bytes[1] = msHigh & 0xff;
  bytes[2] = (msLow >>> 24) & 0xff;
  bytes[3] = (msLow >>> 16) & 0xff;
  bytes[4] = (msLow >>> 8) & 0xff;
  bytes[5] = msLow & 0xff;

  // Version 7 + the upper 4 bits of rand_a / the lower 8 bits of rand_a.
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;

  // The remaining 8 bytes are random. The top 2 bits of the first byte are the variant (10).
  randomFillSync(bytes, 8, 8);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);

  let out = "";
  for (let i = 0; i < 16; i += 1) {
    out += HEX[bytes[i]];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += "-";
  }
  return out;
}
