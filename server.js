// Custom server — wraps Next.js standalone with Socket.io on a single port
// Hooks into startServer's httpServer after it starts
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("node:path");
const { Server } = require("socket.io");
const { OpenClawGateway } = require("./src/lib/openclaw-gateway.js");
const { parseNpcResponse, isValidTaskAction } = require("./src/lib/task-parser.js");
const { TaskManager } = require("./src/lib/task-manager.js");
const { withTaskReminder, normalizeTaskPromptLocale } = require("./src/lib/task-prompt.js");
const {
  getInternalSocketHostname,
  isInternalRequestAuthorized,
} = require("./src/lib/internal-transport.js");

const dir = __dirname;
process.env.NODE_ENV = "production";
process.chdir(dir);

const currentPort = parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOSTNAME || "0.0.0.0";

// Load Next.js config from standalone build
const nextConfig = require(path.join(dir, ".next", "required-server-files.json")).config;
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

require("next");
const { startServer } = require("next/dist/server/lib/start-server");

async function main() {
  const { jwtVerify } = await import("jose");
  const {
    buildAutoExecutionPrompt,
    buildCompletionReportRow,
    buildResumeTaskExecutionPrompt,
    buildTaskActionStartMessage,
    buildQueuedReportRow,
    buildManualTaskReportPrompt,
    enqueueCompletionReport,
    enqueueQueuedReport,
    getProgressNudgeCutoff,
    getPendingReportsForUserAndChannel,
    getTaskAutomationConfig,
    markReportConsumed,
    markReportDelivered,
    shouldDeliverCompletionReport,
    toReportReadyPayload,
  } = await import("./src/lib/task-reporting.ts");
  const {
    buildChannelAccessDeniedPayload,
    summarizeChannelParticipationAccess,
  } = await import("./src/lib/rbac/channel-access.ts");
  const {
    registerMeetingSocketHandlers,
  } = await import("./src/server/meeting-socket.ts");
  const {
    registerMeetingDiscussionHandlers,
  } = await import("./src/server/meeting-discussion.ts");

  const { db, schema } = require("./src/db/server-db.js");
  const { eq, and } = require("drizzle-orm");
  const { parseJson } = require("./src/db/normalize.js");
  const taskManager = new TaskManager(db, schema);
  const { MeetingBroker } = require("./src/lib/meeting-broker.js");
  const reportSchema = { npcReports: schema.npcReports };

  // Start Next.js (this creates and listens on the HTTP server)
  await startServer({
    dir,
    isDev: false,
    config: nextConfig,
    hostname,
    port: currentPort,
    allowRetry: false,
  });

  // Get the underlying HTTP server from the return value
  // startServer returns { port, hostname } but the HTTP server is
  // already listening. We need to access it differently.
  //
  // Alternative: use the http module to find the listening server
  const http = require("node:http");
  // Simpler: create Socket.io on a separate internal port, proxy via Caddy path
  const SOCKET_PORT = currentPort + 1; // 3001
  const socketHttpServer = http.createServer();
  const io = new Server(socketHttpServer, {
    path: "/socket.io",
    cors: { origin: "*" },
  });

  // JWT helpers
  function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("Missing JWT_SECRET");
    return new TextEncoder().encode(secret);
  }

  async function authenticateSocket(socket) {
    try {
      const cookieHeader = socket.handshake.headers.cookie || "";
      const tokenMatch = cookieHeader.match(/token=([^;]+)/);
      if (!tokenMatch) return null;
      const { payload } = await jwtVerify(tokenMatch[1], getJwtSecret());
      return { userId: payload.userId, nickname: payload.nickname };
    } catch {
      return null;
    }
  }

  function emitChannelAccessDenied(socket, input) {
    socket.emit("channel:access-denied", buildChannelAccessDeniedPayload(input));
  }

  async function getSocketChannelParticipationAccess(channelId, userId) {
    const channelRows = await db
      .select({
        id: schema.channels.id,
        groupId: schema.channels.groupId,
        isPublic: schema.channels.isPublic,
        ownerId: schema.channels.ownerId,
      })
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId))
      .limit(1);

    const channel = channelRows[0];
    if (!channel) {
      return null;
    }

    const groupMembershipRows = channel.groupId
      ? await db
          .select({ role: schema.groupMembers.role })
          .from(schema.groupMembers)
          .where(
            and(
              eq(schema.groupMembers.groupId, channel.groupId),
              eq(schema.groupMembers.userId, userId),
            ),
          )
          .limit(1)
      : [];

    const channelMembershipRows = await db
      .select({ userId: schema.channelMembers.userId })
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.userId, userId),
        ),
      )
      .limit(1);

    const access = summarizeChannelParticipationAccess({
      groupId: channel.groupId,
      isPublic: channel.isPublic ?? true,
      hasActiveGroupMembership: groupMembershipRows.length > 0,
      isChannelMember: channel.ownerId === userId || channelMembershipRows.length > 0,
    });

    return { channel, access };
  }

  // In-memory state
  const players = new Map();
  const npcConfigCache = new Map();
  const lastChatTime = new Map();
  const meetingRooms = new Map(); // channelId → { participants: Set, messages: [] }
  const activeBrokers = new Map(); // channelId -> MeetingBroker instance
  const discussionInitiators = new Map(); // channelId → userId
  const userSockets = new Map(); // userId → socketId (one socket per user)
  const channelOwners = new Map(); // channelId → ownerId
  const channelGateways = new Map(); // channelId → OpenClawGateway instance
  const channelChatHistory = new Map(); // channelId -> message[] (all messages kept for session lifetime)
  const npcChatHistory = new Map(); // `${channelId}:${npcId}` -> message[] (all messages kept for session lifetime)
  const CHAT_COOLDOWN_MS = 2000;
  const PROGRESS_NUDGE_SCAN_MS = 60_000;
  const progressNudgeInFlight = new Set();
  const progressNudgeCooldowns = new Map();

  function getSocketLocale(socket) {
    const cookieHeader = socket.handshake.headers.cookie || "";
    const localeMatch = cookieHeader.match(/(?:^|;\s*)deskrpg-locale=([^;]+)/);
    return normalizeTaskPromptLocale(localeMatch && localeMatch[1]);
  }

  function getJoinedSocketsForUserAndChannel(userId, channelId) {
    return Array.from(players.values())
      .filter((player) => player.userId === userId && player.mapId === channelId)
      .map((player) => io.sockets.sockets.get(player.id))
      .filter(Boolean);
  }

  function appendNpcHistoryMessage(channelId, npcId, content) {
    const sanitizedContent = require("./src/lib/task-block-utils.js").sanitizeNpcResponseText(content);
    if (!sanitizedContent.trim()) return null;
    const historyKey = `${channelId}:${npcId}`;
    const history = npcChatHistory.get(historyKey) || [];
    history.push({ role: "npc", content: sanitizedContent, timestamp: Date.now() });
    npcChatHistory.set(historyKey, history);
    return sanitizedContent;
  }

  function appendNpcHistoryMessageForUser(userId, channelId, npcId, content) {
    const sanitizedContent = appendNpcHistoryMessage(channelId, npcId, content);
    if (!sanitizedContent) return;

    const joinedSockets = getJoinedSocketsForUserAndChannel(userId, channelId);
    for (const joinedSocket of joinedSockets) {
      joinedSocket.emit("npc:history-append", { npcId, message: sanitizedContent });
    }
  }

  async function deliverPendingReportsToSocket(socket, userId, channelId) {
    const pendingReports = await getPendingReportsForUserAndChannel(
      db,
      reportSchema,
      { userId, channelId },
    );

    for (const report of pendingReports) {
      const npcConfig = await getNpcConfig(report.npcId);
      socket.emit("npc:report-ready", toReportReadyPayload(report, npcConfig?._name));
      await markReportDelivered(db, reportSchema, report.id);
    }
  }

  async function getAssignerUserId(assignerId) {
    const rows = await db
      .select({ userId: schema.characters.userId })
      .from(schema.characters)
      .where(eq(schema.characters.id, assignerId));
    return rows[0]?.userId || null;
  }

  async function getChannelTaskAutomation(channelId) {
    const rows = await db
      .select({ gatewayConfig: schema.channels.gatewayConfig })
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId));
    return getTaskAutomationConfig(rows[0]?.gatewayConfig || null);
  }

  async function processNpcTaskActions(parsed, input) {
    const taskAutomation = await getChannelTaskAutomation(input.channelId);
    for (const taskAction of parsed.tasks) {
      if (!isValidTaskAction(taskAction)) {
        console.warn("[TaskManager] Invalid task action:", taskAction);
        continue;
      }

      try {
        const task = await taskManager.handleTaskAction(
          taskAction,
          input.channelId,
          input.npcId,
          input.assignerCharacterId,
          { autoNudgeMax: taskAutomation.autoProgressNudgeMax },
        );

        if (!task) continue;

        io.to(input.channelId).emit("task:updated", { task, action: taskAction.action });

        if (shouldDeliverCompletionReport(taskAction)) {
          appendNpcHistoryMessage(input.channelId, input.npcId, parsed.message);
          const report = await enqueueCompletionReport(
            db,
            reportSchema,
            buildCompletionReportRow({
              channelId: input.channelId,
              npcId: input.npcId,
              taskId: task.id,
              targetUserId: input.targetUserId,
              message: parsed.message,
            }),
          );

          if (report) {
            const joinedSockets = getJoinedSocketsForUserAndChannel(input.targetUserId, input.channelId);
            if (joinedSockets.length > 0) {
              const payload = toReportReadyPayload(report, input.npcName);
              for (const joinedSocket of joinedSockets) {
                joinedSocket.emit("npc:report-ready", payload);
              }
              await markReportDelivered(db, reportSchema, report.id);
            }
          }
        }
      } catch (err) {
        console.error("[TaskManager] Error handling task action:", err);
      }
    }
  }

  async function runProgressNudgeForTask(task, promptOverride, reportKind = "progress") {
    if (progressNudgeInFlight.has(task.id)) return;
    progressNudgeInFlight.add(task.id);

    try {
      const npcConfig = await getNpcConfig(task.npcId);
      const agentId = npcConfig?.agentId || npcConfig?.agent_id || null;
      if (!npcConfig || !agentId) return;

      const targetUserId = await getAssignerUserId(task.assignerId);
      if (!targetUserId) return;

      const gateway = await getOrConnectGateway(task.channelId);
      if (!gateway) return;

      const sessionKey = `${npcConfig.sessionKeyPrefix || task.npcId}-dm-${targetUserId}`;
      await taskManager.markTaskNudged(task.id, task.channelId);
      const response = await gateway.chatSend(
        agentId,
        sessionKey,
        withTaskReminder(promptOverride || buildAutoExecutionPrompt(task)),
        () => {},
      );
      const parsed = parseNpcResponse(response);

      await processNpcTaskActions(parsed, {
        channelId: task.channelId,
        npcId: task.npcId,
        npcName: npcConfig._name,
        assignerCharacterId: task.assignerId,
        targetUserId,
      });

      const preview = (parsed.message || "").trim() || `${task.title} 진행 상황을 보고했습니다.`;
      appendNpcHistoryMessage(task.channelId, task.npcId, preview);

      const report = await enqueueQueuedReport(
        db,
        reportSchema,
        buildQueuedReportRow({
          channelId: task.channelId,
          npcId: task.npcId,
          taskId: task.id,
          targetUserId,
          message: preview,
          kind: reportKind,
        }),
      );

      if (report) {
        const joinedSockets = getJoinedSocketsForUserAndChannel(targetUserId, task.channelId);
        if (joinedSockets.length > 0) {
          const payload = toReportReadyPayload(report, npcConfig._name);
          for (const joinedSocket of joinedSockets) {
            joinedSocket.emit("npc:report-ready", payload);
          }
          await markReportDelivered(db, reportSchema, report.id);
        }
      }
    } catch (err) {
      console.error("[task-reporting] Progress nudge failed:", err);
    } finally {
      progressNudgeInFlight.delete(task.id);
    }
  }

  async function scanProgressNudges() {
    try {
      const channelRows = await db
        .select({ id: schema.channels.id, gatewayConfig: schema.channels.gatewayConfig })
        .from(schema.channels);

      for (const channelRow of channelRows) {
        const taskAutomation = getTaskAutomationConfig(channelRow.gatewayConfig);
        if (!taskAutomation.autoProgressNudgeEnabled) continue;

        const cutoffIso = new Date(
          getProgressNudgeCutoff(taskAutomation.autoProgressNudgeMinutes),
        ).toISOString();

        const staleTasks = await taskManager.getStaleInProgressTasks(channelRow.id, cutoffIso);
        for (const task of staleTasks) {
          const autoNudgeMax = task.autoNudgeMax ?? taskAutomation.autoProgressNudgeMax;
          if ((task.autoNudgeCount ?? 0) >= autoNudgeMax) {
            const stalledTask = await taskManager.markTaskStalled(task.id, channelRow.id, "max_nudges_reached");
            if (stalledTask) {
              io.to(channelRow.id).emit("task:updated", { task: stalledTask, action: "stalled" });
            }
            continue;
          }

          const lastNudgedAt = progressNudgeCooldowns.get(task.id) || 0;
          if (Date.now() - lastNudgedAt < taskAutomation.autoProgressNudgeMinutes * 60 * 1000) {
            continue;
          }

          progressNudgeCooldowns.set(task.id, Date.now());
          await runProgressNudgeForTask(task, buildAutoExecutionPrompt(task));
        }
      }
    } catch (err) {
      console.error("[task-reporting] Progress nudge scan failed:", err);
    }
  }

  setInterval(() => {
    void scanProgressNudges();
  }, PROGRESS_NUDGE_SCAN_MS);

  async function getNpcConfig(npcId) {
    if (npcConfigCache.has(npcId)) return npcConfigCache.get(npcId);
    try {
      const rows = await db.select({
        name: schema.npcs.name,
        openclawConfig: schema.npcs.openclawConfig,
        channelId: schema.npcs.channelId,
      }).from(schema.npcs).where(eq(schema.npcs.id, npcId));
      if (rows.length === 0) return null;
      const r = rows[0];
      const openclawConfig = parseJson(r.openclawConfig);
      const config = { ...openclawConfig, _channelId: r.channelId, _name: r.name };
      npcConfigCache.set(npcId, config);
      return config;
    } catch (err) {
      console.error("[npc] DB error:", err);
      return null;
    }
  }

  async function getOrConnectGateway(channelId) {
    if (channelGateways.has(channelId)) {
      const gw = channelGateways.get(channelId);
      if (gw.isConnected()) return gw;
      gw.disconnect();
      channelGateways.delete(channelId);
    }

    try {
      const rows = await db.select({ gatewayConfig: schema.channels.gatewayConfig }).from(schema.channels).where(eq(schema.channels.id, channelId));
      const config = parseJson(rows[0]?.gatewayConfig);
      if (!config?.url || !config?.token) return null;

      const gateway = new OpenClawGateway();
      await gateway.connect(config.url, config.token);
      channelGateways.set(channelId, gateway);
      return gateway;
    } catch (err) {
      console.error(`[gateway] Failed to connect for channel ${channelId.slice(0, 8)}:`, err.message);
      return null;
    }
  }

  async function streamNpcResponse(socket, npcId, npcConfig, userId, message) {
    const agentId = npcConfig.agentId || npcConfig.agent_id || null;
    if (!agentId) {
      socket.emit("npc:response", { npcId, chunk: "[This NPC has no AI agent connected]", done: true });
      return "";
    }

    const channelId = npcConfig._channelId;
    const gateway = channelId ? await getOrConnectGateway(channelId) : null;
    if (!gateway) {
      socket.emit("npc:response", { npcId, chunk: "[Gateway not connected]", done: true });
      return "";
    }

    const sessionKey = `${npcConfig.sessionKeyPrefix || npcId}-dm-${userId}`;

    try {
      const response = await gateway.chatSend(agentId, sessionKey, message, (delta) => {
        socket.emit("npc:response", { npcId, chunk: delta, done: false });
      });
      socket.emit("npc:response", { npcId, chunk: "", done: true });
      return response;
    } catch (err) {
      console.error("[npc] Chat error:", err.message);
      socket.emit("npc:response", { npcId, chunk: "[AI Gateway error]", done: true });
      return "";
    }
  }

  async function generateMeetingSummary(gateway, agentId, sessionKeyPrefix, meetingId, topic, transcript) {
    const summaryPrompt = `다음 회의 내용을 분석하여 JSON으로 응답하세요.

회의 주제: ${topic}

${transcript}

응답 형식 (JSON만, 다른 텍스트 없이):
{
  "keyTopics": ["주제1", "주제2", "주제3"],
  "conclusions": "결론 요약 2-3문장"
}`;

    try {
      const sessionKey = `${sessionKeyPrefix}-summary-${meetingId}`;
      const response = await Promise.race([
        gateway.chatSend(agentId, sessionKey, summaryPrompt, () => {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Summary timeout")), 60000)),
      ]);
      const text = response || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics : [],
          conclusions: typeof parsed.conclusions === "string" ? parsed.conclusions : null,
        };
      }
      return { keyTopics: [], conclusions: null };
    } catch (err) {
      console.warn("[meeting] Summary generation failed:", err.message);
      return { keyTopics: [], conclusions: null };
    }
  }

  async function getNpcConfigsForChannel(channelId) {
    try {
      const rows = await db.select({
        id: schema.npcs.id,
        name: schema.npcs.name,
        openclawConfig: schema.npcs.openclawConfig,
      }).from(schema.npcs).where(eq(schema.npcs.channelId, channelId));
      return rows.map(r => {
        const config = parseJson(r.openclawConfig) || {};
        return {
          id: r.id,
          name: r.name,
          agentId: config.agentId || config.agent_id || null,
          sessionKeyPrefix: config.sessionKeyPrefix || config.session_key_prefix || "",
          role: "Participant",
          passPolicy: config.passPolicy || null,
        };
      });
    } catch (err) {
      console.error("[meeting] Failed to load NPCs:", err);
      return [];
    }
  }

  function isMeetingController(channelId, userId) {
    return discussionInitiators.get(channelId) === userId
        || channelOwners.get(channelId) === userId;
  }

  io.on("connection", async (socket) => {
    const user = await authenticateSocket(socket);
    if (!user) { socket.disconnect(true); return; }

    socket.on("player:join", async (data) => {
      // Verify channel membership
      try {
        const memberRows = await db.select({ role: schema.channelMembers.role })
          .from(schema.channelMembers)
          .where(and(eq(schema.channelMembers.channelId, data.mapId), eq(schema.channelMembers.userId, user.userId)));
        if (memberRows.length === 0) {
          socket.emit("join-error", { error: "Not a member of this channel" });
          return;
        }
      } catch (err) {
        console.error("[socket] Membership check failed:", err);
        // Allow join on DB error (safety net should not block)
      }

      // Cache channel owner and connect gateway
      try {
        const ownerRows = await db.select({ ownerId: schema.channels.ownerId })
          .from(schema.channels).where(eq(schema.channels.id, data.mapId));
        if (ownerRows.length > 0) {
          channelOwners.set(data.mapId, ownerRows[0].ownerId);
        }
        // Connect gateway (non-blocking)
        getOrConnectGateway(data.mapId).catch(() => {});
      } catch (err) {
        console.error("[socket] Channel cache failed:", err);
      }

      // Enforce single channel per user — disconnect previous session
      const prevSocketId = userSockets.get(user.userId);
      if (prevSocketId && prevSocketId !== socket.id) {
        const prevSocket = io.sockets.sockets.get(prevSocketId);
        if (prevSocket) {
          prevSocket.emit("session:kicked", { reason: "다른 위치에서 접속하여 현재 세션이 종료되었습니다." });
          prevSocket.disconnect(true);
        }
        players.delete(prevSocketId);
      }

      const playerState = {
        id: socket.id, userId: user.userId,
        characterId: data.characterId, characterName: data.characterName,
        appearance: data.appearance, mapId: data.mapId,
        x: data.x, y: data.y, direction: "down", animation: "idle",
      };
      players.set(socket.id, playerState);
      userSockets.set(user.userId, socket.id);
      socket.join(data.mapId);
      const mapPlayers = Array.from(players.values()).filter(p => p.mapId === data.mapId && p.id !== socket.id);
      socket.emit("players:state", { players: mapPlayers });
      // Send channel chat history to the joining player
      const chatHistory = channelChatHistory.get(data.mapId);
      if (chatHistory && chatHistory.length > 0) {
        socket.emit("chat:history", { messages: chatHistory });
      }
      // Send pending NPC reports
      await deliverPendingReportsToSocket(socket, user.userId, data.mapId);
      socket.to(data.mapId).emit("player:joined", playerState);
    });

    socket.on("player:move", (data) => {
      const player = players.get(socket.id);
      if (!player) return;
      Object.assign(player, { x: data.x, y: data.y, direction: data.direction, animation: data.animation });
      socket.to(player.mapId).emit("player:moved", { id: socket.id, ...data });
    });

    socket.on("npc:chat", async (data) => {
      const { npcId, message } = data || {};
      if (!npcId || !message) return;
      const trimmed = String(message).trim().slice(0, 500);
      if (!trimmed) return;
      const now = Date.now();
      if (now - (lastChatTime.get(socket.id) || 0) < CHAT_COOLDOWN_MS) {
        socket.emit("npc:response", { npcId, chunk: "[Wait before sending.]", done: true });
        return;
      }
      lastChatTime.set(socket.id, now);
      const npcConfig = await getNpcConfig(npcId);
      if (!npcConfig) { socket.emit("npc:response", { npcId, chunk: "[NPC not found]", done: true }); return; }
      const player = players.get(socket.id);
      const historyKey = player ? `${player.mapId}:${npcId}` : npcId;
      const npcHistory = npcChatHistory.get(historyKey) || [];
      npcHistory.push({ role: "player", content: trimmed, timestamp: Date.now() });
      // 매 메시지에 태스크 프로토콜 리마인더 주입 (LLM 프로토콜 준수 강화)
      const messageToSend = withTaskReminder(trimmed, getSocketLocale(socket));
      const response = await streamNpcResponse(socket, npcId, npcConfig, user.userId, messageToSend);
      if (response) {
        npcHistory.push({ role: "npc", content: response, timestamp: Date.now() });

        // Task Parser: 응답에서 태스크 메타데이터 추출
        const parsed = parseNpcResponse(response);

        // 태스크 처리 (클라이언트는 done:true에서 json:task 블록을 직접 strip)
        if (parsed.tasks.length > 0 && player?.characterId) {
          await processNpcTaskActions(parsed, {
            channelId: npcConfig._channelId,
            npcId,
            npcName: npcConfig._name,
            assignerCharacterId: player.characterId,
            targetUserId: player.userId,
          });
        } else if (parsed.tasks.length > 0) {
          console.warn("[TaskManager] No characterId for socket", socket.id);
        }

        // Notify client that NPC has a completed response — client will check distance and move NPC if needed
        socket.emit("npc:response-complete", { npcId, npcName: npcConfig._name || npcId });
      }
      npcChatHistory.set(historyKey, npcHistory);
    });

    socket.on("task:list", async ({ channelId, npcId }) => {
      try {
        const tasks = npcId
          ? await taskManager.getTasksByNpc(npcId)
          : await taskManager.getTasksByChannel(channelId);
        socket.emit("task:list-response", { tasks, npcId: npcId || null });
      } catch (err) {
        console.error("[TaskManager] Error fetching tasks:", err);
        socket.emit("task:list-response", { tasks: [], npcId: npcId || null });
      }
    });

    socket.on("task:delete", async ({ taskId }) => {
      try {
        const player = players.get(socket.id);
        if (!player) return;
        // 채널 소속 태스크만 삭제 가능 (권한 체크)
        const deleted = await taskManager.deleteTask(taskId, player.mapId);
        if (deleted) {
          io.to(player.mapId).emit("task:deleted", { taskId });
        }
      } catch (err) {
        console.error("[TaskManager] Error deleting task:", err);
      }
    });

    socket.on("task:request-report", async ({ taskId }) => {
      try {
        const player = players.get(socket.id);
        if (!player || !taskId) return;

        const task = await taskManager.getTaskById(taskId, player.mapId);
        if (!task) return;
        if (task.status === "complete" || task.status === "cancelled") return;

        let runnableTask = task;
        if (task.status === "stalled") {
          const resumedTask = await taskManager.resumeTask(task.id, player.mapId);
          if (!resumedTask) return;
          io.to(player.mapId).emit("task:updated", { task: resumedTask, action: "resume" });
          runnableTask = resumedTask;
        }

        appendNpcHistoryMessageForUser(
          player.userId,
          player.mapId,
          runnableTask.npcId,
          buildTaskActionStartMessage({ title: runnableTask.title }, "request-report"),
        );

        await runProgressNudgeForTask(runnableTask, buildManualTaskReportPrompt({
          title: runnableTask.title,
          summary: runnableTask.summary,
          npcTaskId: runnableTask.npcTaskId,
          status: runnableTask.status,
        }), "manual");
      } catch (err) {
        console.error("[TaskManager] Error requesting task report:", err);
      }
    });

    socket.on("task:resume", async ({ taskId }) => {
      try {
        const player = players.get(socket.id);
        if (!player || !taskId) return;

        const resumedTask = await taskManager.resumeTask(taskId, player.mapId);
        if (resumedTask) {
          io.to(player.mapId).emit("task:updated", { task: resumedTask, action: "resume" });

          appendNpcHistoryMessageForUser(
            player.userId,
            player.mapId,
            resumedTask.npcId,
            buildTaskActionStartMessage({ title: resumedTask.title }, "resume"),
          );

          await runProgressNudgeForTask(resumedTask, buildResumeTaskExecutionPrompt({
            title: resumedTask.title,
            summary: resumedTask.summary,
            npcTaskId: resumedTask.npcTaskId,
          }), "resume");
        }
      } catch (err) {
        console.error("[TaskManager] Error resuming task:", err);
      }
    });

    socket.on("task:complete", async ({ taskId }) => {
      try {
        const player = players.get(socket.id);
        if (!player || !taskId) return;

        const completedTask = await taskManager.completeTask(taskId, player.mapId);
        if (completedTask) {
          io.to(player.mapId).emit("task:updated", { task: completedTask, action: "complete_manual" });
        }
      } catch (err) {
        console.error("[TaskManager] Error completing task:", err);
      }
    });

    socket.on("npc:history", ({ npcId }) => {
      const player = players.get(socket.id);
      if (!player || !npcId) return;
      const historyKey = `${player.mapId}:${npcId}`;
      const history = npcChatHistory.get(historyKey) || [];
      socket.emit("npc:history", { npcId, messages: history });
    });

    socket.on("npc:reset-chat", ({ npcId }) => {
      const player = players.get(socket.id);
      if (!player || !npcId) return;
      const historyKey = `${player.mapId}:${npcId}`;
      npcChatHistory.delete(historyKey);
    });

    socket.on("npc:report-consumed", async ({ reportId }) => {
      if (!reportId) return;
      try {
        await markReportConsumed(db, reportSchema, reportId);
      } catch (err) {
        console.error("[task-reporting] Error marking report consumed:", err);
      }
    });

    registerMeetingSocketHandlers({
      io,
      socket,
      deps: {
        meetingRooms,
        players,
        lastChatTime,
        chatCooldownMs: CHAT_COOLDOWN_MS,
        user,
        getParticipationAccess: getSocketChannelParticipationAccess,
        emitChannelAccessDenied,
        storeMeetingFallbackPlayer: true,
        onMeetingChat: ({ channelId, message, player }) => {
          const broker = activeBrokers.get(channelId);
          if (broker && broker.isRunning()) {
            const userName = player?.characterName || user.nickname;
            broker.addUserMessage(userName, message);
          }
        },
      },
    });

    registerMeetingDiscussionHandlers({
      io,
      socket,
      deps: {
        activeBrokers,
        discussionInitiators,
        meetingRooms,
        players,
        user,
        getOrConnectGateway,
        getNpcConfigsForChannel,
        canControlMeeting: isMeetingController,
        createMeetingBroker: (config, callbacks) => new MeetingBroker(config, callbacks),
        generateMeetingSummary,
        persistMeetingMinutes: async (input) => {
          try {
            const [minutesRow] = await db.insert(schema.meetingMinutes).values({
              channelId: input.channelId,
              topic: input.topic,
              transcript: input.transcript,
              participants: JSON.stringify(input.participants),
              totalTurns: input.totalTurns,
              durationSeconds: input.durationSeconds || null,
              initiatorId: input.initiatorId,
              keyTopics: JSON.stringify(input.keyTopics),
              conclusions: input.conclusions,
            }).returning();
            return minutesRow?.id ?? null;
          } catch (err) {
            console.error("[meeting] Failed to save minutes:", err.message);
            return null;
          }
        },
      },
    });

    // --- NPC Movement ---
    socket.on("npc:call", ({ channelId, npcId }) => {
      if (!channelId || !npcId) return;
      const player = players.get(socket.id);
      if (!player) return;
      io.to(channelId).emit("npc:come-to-player", {
        npcId,
        targetPlayerId: socket.id,
      });
    });

    socket.on("npc:return-home", ({ channelId, npcId }) => {
      if (!channelId || !npcId) return;
      io.to(channelId).emit("npc:returning", { npcId });
    });

    socket.on("npc:position-update", ({ channelId, npcId, x, y, direction }) => {
      if (!channelId || !npcId) return;
      socket.to(channelId).emit("npc:position-sync", { npcId, x, y, direction });
    });

    socket.on("npc:arrived", ({ channelId, npcId }) => {
      if (!channelId || !npcId) return;
      socket.to(channelId).emit("npc:stop-moving", { npcId });
    });

    // Channel chat (user-to-user)
    socket.on("chat:send", ({ message }) => {
      const player = players.get(socket.id);
      if (!player) return;
      const trimmed = String(message || "").trim().slice(0, 500);
      if (!trimmed) return;
      const now = Date.now();
      if (now - (lastChatTime.get(socket.id) || 0) < CHAT_COOLDOWN_MS) return;
      lastChatTime.set(socket.id, now);

      const chatMessage = {
        id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sender: player.characterName || user.nickname,
        senderId: socket.id,
        content: trimmed,
        timestamp: now,
      };
      // Store in channel chat history
      const history = channelChatHistory.get(player.mapId) || [];
      history.push(chatMessage);
      channelChatHistory.set(player.mapId, history);
      io.to(player.mapId).emit("chat:message", chatMessage);
    });

    // NPC management broadcasts (re-broadcast to room)
    socket.on("npc:broadcast-add", (npcData) => {
      const player = players.get(socket.id);
      if (!player) return;
      socket.to(player.mapId).emit("npc:added", npcData);
      npcConfigCache.delete(npcData.id);
    });

    socket.on("npc:broadcast-update", (data) => {
      const player = players.get(socket.id);
      if (!player) return;
      socket.to(player.mapId).emit("npc:updated", data);
      if (data.npcId) npcConfigCache.delete(data.npcId);
    });

    socket.on("npc:broadcast-remove", (data) => {
      const player = players.get(socket.id);
      if (!player) return;
      socket.to(player.mapId).emit("npc:removed", data);
      if (data.npcId) npcConfigCache.delete(data.npcId);
    });

    // Map editing broadcasts (owner only)
    socket.on("map:object-add", (data) => {
      const player = players.get(socket.id);
      if (!player) return;
      if (channelOwners.get(player.mapId) !== user.userId) return;
      socket.to(player.mapId).emit("map:object-added", data);
    });

    socket.on("map:object-remove", (data) => {
      const player = players.get(socket.id);
      if (!player) return;
      if (channelOwners.get(player.mapId) !== user.userId) return;
      socket.to(player.mapId).emit("map:object-removed", data);
    });

    socket.on("map:tiles-update", (data) => {
      const player = players.get(socket.id);
      if (!player) return;
      if (channelOwners.get(player.mapId) !== user.userId) return;
      socket.to(player.mapId).emit("map:tiles-updated", data);
    });

    socket.on("disconnect", () => {
      const player = players.get(socket.id);
      if (player) {
        socket.to(player.mapId).emit("player:left", { id: socket.id });
        players.delete(socket.id);
        if (userSockets.get(user.userId) === socket.id) {
          userSockets.delete(user.userId);
        }

        // Disconnect gateway if channel is now empty
        const leftChannelId = player.mapId;
        if (leftChannelId) {
          const remaining = Array.from(players.values()).filter(p => p.mapId === leftChannelId);
          if (remaining.length === 0) {
            const gw = channelGateways.get(leftChannelId);
            if (gw) {
              gw.disconnect();
              channelGateways.delete(leftChannelId);
            }
          }
        }
      }
      // Clean up meeting room participation
      for (const [chId, room] of meetingRooms.entries()) {
        if (room.participants.has(socket.id)) {
          room.participants.delete(socket.id);
          socket.to(`meeting-${chId}`).emit("meeting:participant-left", { id: socket.id });
        }
      }
      // Stop broker if no participants remain
      for (const [chId, broker] of activeBrokers.entries()) {
        const room = meetingRooms.get(chId);
        if (room && room.participants.size === 0) {
          broker.stop();
          activeBrokers.delete(chId);
        }
      }
      lastChatTime.delete(socket.id);
    });
  });

  // Internal HTTP endpoints for cross-process communication
  socketHttpServer.on("request", (req, res) => {
    if (!req.url || !req.url.startsWith("/_internal")) return;

    res.setHeader("Content-Type", "application/json");

    if (!isInternalRequestAuthorized(req.headers)) {
      res.writeHead(403);
      res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
      return;
    }

    // POST /_internal/rpc — proxy RPC calls from API routes to gateway
    if (req.method === "POST" && req.url === "/_internal/rpc") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { channelId, method, params } = JSON.parse(body);
          const gateway = await getOrConnectGateway(channelId);
          if (!gateway) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Gateway not connected" }));
            return;
          }
          const result = await gateway._rpcRequest(method, params || {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // POST /_internal/emit
    if (req.method === "POST" && req.url === "/_internal/emit") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { event, room, targetUserId, payload } = JSON.parse(body);

          // Gateway reconnection on config change
          if (event === "gateway:config-updated" && payload?.channelId) {
            const gw = channelGateways.get(payload.channelId);
            if (gw) {
              gw.disconnect();
              channelGateways.delete(payload.channelId);
            }
          }

          if (targetUserId) {
            const socketId = userSockets.get(targetUserId);
            if (socketId) {
              io.to(socketId).emit(event, payload);
              if (event === "member:kicked" && payload?.channelId) {
                const targetSocket = io.sockets.sockets.get(socketId);
                if (targetSocket) {
                  targetSocket.leave(payload.channelId);
                }
              }
            }
          } else if (room) {
            io.to(room).emit(event, payload);
          }

          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
      return;
    }

    // GET /_internal/room-members?channelId=X
    if (req.method === "GET" && req.url.startsWith("/_internal/room-members")) {
      const url = new URL(req.url, "http://localhost");
      const channelId = url.searchParams.get("channelId");

      if (!channelId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "channelId required" }));
        return;
      }

      const roomSockets = io.sockets.adapter.rooms.get(channelId);
      const userIds = [];

      if (roomSockets) {
        for (const socketId of roomSockets) {
          const player = players.get(socketId);
          if (player && player.userId) {
            userIds.push(player.userId);
          }
        }
      }

      res.writeHead(200);
      res.end(JSON.stringify({ userIds }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });

  const internalHostname = getInternalSocketHostname(process.env);
  socketHttpServer.listen(SOCKET_PORT, internalHostname, () => {
    console.log(`[socket.io] Listening on http://${internalHostname}:${SOCKET_PORT}`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
