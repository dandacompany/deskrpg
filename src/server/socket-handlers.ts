import { Server, Socket } from "socket.io";
import { jwtVerify } from "jose";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import * as schema from "../db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlayerState {
  id: string; // socket.id
  userId: string;
  characterId: string;
  characterName: string;
  appearance: unknown; // character appearance JSON
  mapId: string;
  x: number;
  y: number;
  direction: string;
  animation: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface NpcConfig {
  name: string;
  persona: string;
}

// ---------------------------------------------------------------------------
// Meeting room types
// ---------------------------------------------------------------------------

interface MeetingMessage {
  id: string;
  sender: string;
  senderId: string;
  senderType: "user" | "npc";
  content: string;
  timestamp: number;
}

interface MeetingRoom {
  participants: Set<string>;
  messages: MeetingMessage[];
}

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

const players = new Map<string, PlayerState>();

// NPC config cache: npcId -> config
const npcConfigCache = new Map<string, NpcConfig>();

// Conversation history: `${socketId}:${npcId}` -> messages
const conversationHistory = new Map<string, ChatMessage[]>();

// Rate limit: socketId -> last message timestamp
const lastChatTime = new Map<string, number>();

// Meeting rooms: channelId -> MeetingRoom
const meetingRooms = new Map<string, MeetingRoom>();

const CHAT_COOLDOWN_MS = 2000;
const MAX_HISTORY_MESSAGES = 20; // keep last N messages per conversation

// ---------------------------------------------------------------------------
// DB helper (lazy init)
// ---------------------------------------------------------------------------

let _pool: Pool | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getDb() {
  if (!_db) {
    const connStr = process.env.DATABASE_URL;
    if (!connStr) throw new Error("Missing DATABASE_URL");
    _pool = new Pool({ connectionString: connStr });
    _db = drizzle(_pool, { schema });
  }
  return _db;
}

// ---------------------------------------------------------------------------
// NPC config loader
// ---------------------------------------------------------------------------

async function getNpcConfig(npcId: string): Promise<NpcConfig | null> {
  const cached = npcConfigCache.get(npcId);
  if (cached) return cached;

  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.npcs)
      .where(eq(schema.npcs.id, npcId))
      .limit(1);

    if (rows.length === 0) return null;

    const npc = rows[0];
    const openclawConfig = npc.openclawConfig as { persona?: string };
    const config: NpcConfig = {
      name: npc.name,
      persona: openclawConfig?.persona || `You are ${npc.name}, an NPC in DeskRPG.`,
    };

    npcConfigCache.set(npcId, config);
    return config;
  } catch (err) {
    console.error(`[npc] Failed to load config for ${npcId}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// OpenRouter streaming call
// ---------------------------------------------------------------------------

async function streamNpcResponse(
  socket: Socket,
  npcId: string,
  npcConfig: NpcConfig,
  history: ChatMessage[],
): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    socket.emit("npc:response", {
      npcId,
      chunk: "[AI service not configured. Set OPENROUTER_API_KEY.]",
      done: true,
    });
    return;
  }

  const messages = [
    { role: "system", content: npcConfig.persona },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://deskrpg.dante-labs.com",
        "X-Title": "DeskRPG NPC Chat",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages,
        stream: true,
        max_tokens: 300,
        temperature: 0.8,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[npc] OpenRouter error ${res.status}:`, errText);
      socket.emit("npc:response", {
        npcId,
        chunk: "[AI is unavailable right now. Try again later.]",
        done: true,
      });
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      socket.emit("npc:response", { npcId, chunk: "[No response]", done: true });
      return;
    }

    const decoder = new TextDecoder();
    let fullResponse = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          socket.emit("npc:response", { npcId, chunk: "", done: true });
          break;
        }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            fullResponse += content;
            socket.emit("npc:response", { npcId, chunk: content, done: false });
          }

          // Check if this is the final chunk
          const finishReason = parsed.choices?.[0]?.finish_reason;
          if (finishReason) {
            socket.emit("npc:response", { npcId, chunk: "", done: true });
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }

    // Add assistant response to history
    if (fullResponse) {
      const convKey = `${socket.id}:${npcId}`;
      const conv = conversationHistory.get(convKey) || [];
      conv.push({ role: "assistant", content: fullResponse });
      // Trim history
      if (conv.length > MAX_HISTORY_MESSAGES) {
        conv.splice(0, conv.length - MAX_HISTORY_MESSAGES);
      }
      conversationHistory.set(convKey, conv);
    }
  } catch (err) {
    console.error("[npc] Stream error:", err);
    socket.emit("npc:response", {
      npcId,
      chunk: "[Connection error. Try again.]",
      done: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Meeting room: load all NPCs for a channel
// ---------------------------------------------------------------------------

async function getNpcConfigsForChannel(
  channelId: string,
): Promise<{ id: string; name: string; persona: string }[]> {
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.npcs)
      .where(eq(schema.npcs.channelId, channelId));

    return rows.map((r) => {
      const cfg = r.openclawConfig as { persona?: string };
      return {
        id: r.id,
        name: r.name,
        persona: cfg?.persona || `You are ${r.name}, an NPC in DeskRPG.`,
      };
    });
  } catch (err) {
    console.error("[meeting] Failed to load NPCs for channel:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Meeting room: stream NPC response to the meeting group
// ---------------------------------------------------------------------------

async function streamMeetingNpcResponse(
  io: Server,
  channelId: string,
  npcConfig: { id: string; name: string; persona: string },
  room: MeetingRoom,
  userMessage: string,
  userName: string,
): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return;

  // Build context from recent meeting messages
  const recentMessages = room.messages.slice(-10).map((m) => ({
    role: m.senderType === "user" ? ("user" as const) : ("assistant" as const),
    content: `[${m.sender}]: ${m.content}`,
  }));

  const messages = [
    {
      role: "system" as const,
      content: `${npcConfig.persona}\n\nYou are in a group meeting. Multiple people are talking. Respond naturally and briefly (1-2 sentences). You are ${npcConfig.name}. Address people by name when appropriate. The latest message was from ${userName}.`,
    },
    ...recentMessages,
  ];

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://deskrpg.dante-labs.com",
        "X-Title": "DeskRPG Meeting Room",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages,
        stream: true,
        max_tokens: 150,
        temperature: 0.8,
      }),
    });

    if (!res.ok) return;
    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let fullResponse = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          io.to(`meeting-${channelId}`).emit("meeting:npc-stream", {
            npcId: npcConfig.id,
            npcName: npcConfig.name,
            chunk: "",
            done: true,
          });
          break;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            fullResponse += content;
            io.to(`meeting-${channelId}`).emit("meeting:npc-stream", {
              npcId: npcConfig.id,
              npcName: npcConfig.name,
              chunk: content,
              done: false,
            });
          }
          if (parsed.choices?.[0]?.finish_reason) {
            io.to(`meeting-${channelId}`).emit("meeting:npc-stream", {
              npcId: npcConfig.id,
              npcName: npcConfig.name,
              chunk: "",
              done: true,
            });
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }

    // Store completed NPC message
    if (fullResponse) {
      const npcMessage: MeetingMessage = {
        id: `msg-${Date.now()}-${npcConfig.id}`,
        sender: npcConfig.name,
        senderId: `npc-${npcConfig.id}`,
        senderType: "npc",
        content: fullResponse,
        timestamp: Date.now(),
      };
      room.messages.push(npcMessage);
      if (room.messages.length > 100) {
        room.messages.splice(0, room.messages.length - 100);
      }
    }
  } catch (err) {
    console.error(`[meeting] NPC stream error for ${npcConfig.name}:`, err);
  }
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Missing JWT_SECRET");
  return new TextEncoder().encode(secret);
}

async function authenticateSocket(
  socket: Socket,
): Promise<{ userId: string; nickname: string } | null> {
  try {
    const cookieHeader = socket.handshake.headers.cookie || "";
    const tokenMatch = cookieHeader.match(/token=([^;]+)/);
    if (!tokenMatch) return null;

    const { payload } = await jwtVerify(tokenMatch[1], getJwtSecret());
    return {
      userId: payload.userId as string,
      nickname: payload.nickname as string,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function setupSocketHandlers(io: Server) {
  io.on("connection", async (socket) => {
    const user = await authenticateSocket(socket);
    if (!user) {
      socket.disconnect(true);
      return;
    }

    console.log(`[socket] Player connected: ${user.nickname} (${socket.id})`);

    // ----- player:join -----
    socket.on(
      "player:join",
      (data: {
        characterId: string;
        characterName: string;
        appearance: unknown;
        mapId: string;
        x: number;
        y: number;
      }) => {
        const playerState: PlayerState = {
          id: socket.id,
          userId: user.userId,
          characterId: data.characterId,
          characterName: data.characterName,
          appearance: data.appearance,
          mapId: data.mapId,
          x: data.x,
          y: data.y,
          direction: "down",
          animation: "idle",
        };

        players.set(socket.id, playerState);
        socket.join(data.mapId);

        // Send current players on this map to the joining player
        const mapPlayers = Array.from(players.values()).filter(
          (p) => p.mapId === data.mapId && p.id !== socket.id,
        );
        socket.emit("players:state", { players: mapPlayers });

        // Broadcast to others in the same map
        socket.to(data.mapId).emit("player:joined", playerState);
      },
    );

    // ----- player:move -----
    socket.on(
      "player:move",
      (data: {
        x: number;
        y: number;
        direction: string;
        animation: string;
      }) => {
        const player = players.get(socket.id);
        if (!player) return;

        player.x = data.x;
        player.y = data.y;
        player.direction = data.direction;
        player.animation = data.animation;

        socket.to(player.mapId).emit("player:moved", {
          id: socket.id,
          x: data.x,
          y: data.y,
          direction: data.direction,
          animation: data.animation,
        });
      },
    );

    // ----- npc:chat -----
    socket.on(
      "npc:chat",
      async (data: { npcId: string; message: string }) => {
        const { npcId, message } = data;

        // Validate
        if (!npcId || !message || typeof message !== "string") return;
        const trimmed = message.trim().slice(0, 500);
        if (!trimmed) return;

        // Rate limit
        const now = Date.now();
        const lastTime = lastChatTime.get(socket.id) || 0;
        if (now - lastTime < CHAT_COOLDOWN_MS) {
          socket.emit("npc:response", {
            npcId,
            chunk: "[Please wait before sending another message.]",
            done: true,
          });
          return;
        }
        lastChatTime.set(socket.id, now);

        // Load NPC config
        const npcConfig = await getNpcConfig(npcId);
        if (!npcConfig) {
          socket.emit("npc:response", {
            npcId,
            chunk: "[NPC not found.]",
            done: true,
          });
          return;
        }

        // Add user message to conversation history
        const convKey = `${socket.id}:${npcId}`;
        const history = conversationHistory.get(convKey) || [];
        history.push({ role: "user", content: trimmed });

        // Trim history
        if (history.length > MAX_HISTORY_MESSAGES) {
          history.splice(0, history.length - MAX_HISTORY_MESSAGES);
        }
        conversationHistory.set(convKey, history);

        // Stream response
        await streamNpcResponse(socket, npcId, npcConfig, history);
      },
    );

    // ----- meeting:join -----
    socket.on("meeting:join", ({ channelId }: { channelId: string }) => {
      if (!channelId) return;

      let room = meetingRooms.get(channelId);
      if (!room) {
        room = { participants: new Set(), messages: [] };
        meetingRooms.set(channelId, room);
      }
      room.participants.add(socket.id);
      socket.join(`meeting-${channelId}`);

      // Send current state to the joining user
      const participantList = Array.from(room.participants)
        .map((sid) => {
          const p = players.get(sid);
          return p
            ? { id: sid, name: p.characterName, appearance: p.appearance }
            : null;
        })
        .filter(Boolean);

      socket.emit("meeting:state", {
        participants: participantList,
        messages: room.messages.slice(-50),
      });

      // Notify others
      const player = players.get(socket.id);
      socket.to(`meeting-${channelId}`).emit("meeting:participant-joined", {
        id: socket.id,
        name: player?.characterName || "Unknown",
        appearance: player?.appearance,
      });

      console.log(
        `[meeting] ${player?.characterName || socket.id} joined meeting in channel ${channelId}`,
      );
    });

    // ----- meeting:leave -----
    socket.on("meeting:leave", ({ channelId }: { channelId: string }) => {
      if (!channelId) return;
      const room = meetingRooms.get(channelId);
      if (room) {
        room.participants.delete(socket.id);
        socket.leave(`meeting-${channelId}`);
        socket
          .to(`meeting-${channelId}`)
          .emit("meeting:participant-left", { id: socket.id });
      }
    });

    // ----- meeting:chat -----
    socket.on(
      "meeting:chat",
      async ({ channelId, message }: { channelId: string; message: string }) => {
        if (!channelId || !message) return;

        // Rate limit
        const now = Date.now();
        if (now - (lastChatTime.get(socket.id) || 0) < CHAT_COOLDOWN_MS) return;
        lastChatTime.set(socket.id, now);

        const player = players.get(socket.id);
        const trimmed = String(message).trim().slice(0, 500);
        if (!trimmed) return;

        const userMessage: MeetingMessage = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          sender: player?.characterName || "Unknown",
          senderId: socket.id,
          senderType: "user",
          content: trimmed,
          timestamp: Date.now(),
        };

        // Store and broadcast
        let room = meetingRooms.get(channelId);
        if (!room) {
          room = { participants: new Set(), messages: [] };
          meetingRooms.set(channelId, room);
        }
        room.messages.push(userMessage);
        if (room.messages.length > 100) {
          room.messages.splice(0, room.messages.length - 100);
        }

        io.to(`meeting-${channelId}`).emit("meeting:message", userMessage);

        // Trigger NPC responses with staggered delays
        const npcConfigs = await getNpcConfigsForChannel(channelId);
        for (const npc of npcConfigs) {
          const delay = 1000 + Math.random() * 2000;
          setTimeout(async () => {
            await streamMeetingNpcResponse(
              io,
              channelId,
              npc,
              room!,
              trimmed,
              player?.characterName || "Unknown",
            );
          }, delay);
        }
      },
    );

    // ----- disconnect -----
    socket.on("disconnect", () => {
      const player = players.get(socket.id);
      if (player) {
        socket.to(player.mapId).emit("player:left", { id: socket.id });

        // Save last position to DB
        const px = Math.round(player.x);
        const py = Math.round(player.y);
        console.log(`[socket] Saving position for ${player.characterName}: (${px}, ${py}) channel=${player.mapId} user=${player.userId}`);
        try {
          // Use the shared db + schema from src/db (supports both PG and SQLite)
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const dbModule = require("../db");
          const result = dbModule.db.update(dbModule.channelMembers)
            .set({ lastX: px, lastY: py })
            .where(
              and(
                eq(dbModule.channelMembers.channelId, player.mapId),
                eq(dbModule.channelMembers.userId, player.userId),
              )
            );
          // Handle both sync (SQLite) and async (PG)
          if (result && typeof result.then === "function") {
            result.then(() => {
              console.log(`[socket] Position saved OK for ${player.characterName}`);
            }).catch((err: Error) => {
              console.error("[socket] Position save failed (async):", err.message);
            });
          }
        } catch (e) {
          console.error("[socket] Position save failed (sync):", e instanceof Error ? e.message : e);
        }

        players.delete(socket.id);
        console.log(
          `[socket] Player disconnected: ${user.nickname} (${socket.id})`,
        );
      }

      // Clean up meeting room participation
      for (const [channelId, room] of meetingRooms.entries()) {
        if (room.participants.has(socket.id)) {
          room.participants.delete(socket.id);
          socket
            .to(`meeting-${channelId}`)
            .emit("meeting:participant-left", { id: socket.id });
        }
      }

      // Clean up conversation history for this socket
      const keysToDelete: string[] = [];
      conversationHistory.forEach((_, key) => {
        if (key.startsWith(`${socket.id}:`)) {
          keysToDelete.push(key);
        }
      });
      keysToDelete.forEach((key) => conversationHistory.delete(key));
      lastChatTime.delete(socket.id);
    });
  });
}
