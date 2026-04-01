import { and, asc, eq, isNull } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm/sql";

export interface TaskAutomationConfig {
  autoProgressNudgeEnabled: boolean;
  autoProgressNudgeMinutes: number;
  autoProgressNudgeMax: number;
  reportWaitSeconds: number;
}

export interface CompletionReportRowInput {
  channelId: string;
  npcId: string;
  taskId: string;
  targetUserId: string;
  message: string;
}

export interface QueuedReportRowInput extends CompletionReportRowInput {
  kind?: string;
}

export interface PendingReportLookupInput {
  channelId: string;
  userId: string;
}

export interface QueuedReportRow {
  id: string;
  channelId: string;
  npcId: string;
  taskId: string;
  targetUserId: string;
  kind: string;
  message: string;
  status: ReportStatus;
  createdAt: string;
  deliveredAt: string | null;
  consumedAt: string | null;
}

export interface ReportReadyPayload {
  reportId: string;
  npcId: string;
  npcName?: string;
  message: string;
  kind: string;
}

type ReportStatus = "pending" | "delivered" | "consumed";

type ReportRow = {
  id: string;
  channelId: string;
  npcId: string;
  taskId: string;
  targetUserId: string;
  kind: string;
  message: string;
  status: ReportStatus;
  createdAt: string | Date;
  deliveredAt: string | Date | null;
  consumedAt: string | Date | null;
};

type ReportSchema = {
  npcReports: {
    channelId: SQLWrapper;
    targetUserId: SQLWrapper;
    consumedAt: SQLWrapper;
    createdAt: SQLWrapper;
    id: SQLWrapper;
  };
};

type ReportDb = {
  insert: (...args: unknown[]) => {
    values: (value: unknown) => {
      returning: () => Promise<ReportRow[]>;
    };
  };
  update: (...args: unknown[]) => {
    set: (value: unknown) => {
      where: (condition: unknown) => Promise<unknown>;
    };
  };
  select: (...args: unknown[]) => {
    from: (table: unknown) => {
      where: (condition: unknown) => {
        orderBy: (value: unknown) => Promise<ReportRow[]>;
      };
    };
  };
};

function asReportDb(db: unknown): ReportDb {
  return db as ReportDb;
}

function asReportSchema(schema: unknown): ReportSchema {
  return schema as ReportSchema;
}

const DEFAULT_TASK_AUTOMATION_CONFIG: TaskAutomationConfig = {
  autoProgressNudgeEnabled: false,
  autoProgressNudgeMinutes: 5,
  autoProgressNudgeMax: 5,
  reportWaitSeconds: 20,
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeTimestamp(value: string | Date | null | undefined) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeReportRow(row: ReportRow | undefined): QueuedReportRow | null {
  if (!row) return null;
  return {
    ...row,
    createdAt: normalizeTimestamp(row.createdAt) ?? nowIso(),
    deliveredAt: normalizeTimestamp(row.deliveredAt),
    consumedAt: normalizeTimestamp(row.consumedAt),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseGatewayConfig(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parseGatewayConfig(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

export function getTaskAutomationConfig(gatewayConfig: unknown): TaskAutomationConfig {
  const root = parseGatewayConfig(gatewayConfig);
  const taskAutomation = asRecord(root?.taskAutomation);

  return {
    autoProgressNudgeEnabled:
      typeof taskAutomation?.autoProgressNudgeEnabled === "boolean"
        ? taskAutomation.autoProgressNudgeEnabled
        : DEFAULT_TASK_AUTOMATION_CONFIG.autoProgressNudgeEnabled,
    autoProgressNudgeMinutes:
      typeof taskAutomation?.autoProgressNudgeMinutes === "number"
        ? taskAutomation.autoProgressNudgeMinutes
        : DEFAULT_TASK_AUTOMATION_CONFIG.autoProgressNudgeMinutes,
    autoProgressNudgeMax:
      typeof taskAutomation?.autoProgressNudgeMax === "number"
        ? taskAutomation.autoProgressNudgeMax
        : DEFAULT_TASK_AUTOMATION_CONFIG.autoProgressNudgeMax,
    reportWaitSeconds:
      typeof taskAutomation?.reportWaitSeconds === "number"
        ? taskAutomation.reportWaitSeconds
        : DEFAULT_TASK_AUTOMATION_CONFIG.reportWaitSeconds,
  };
}

export function shouldDeliverCompletionReport(taskAction: { action?: string }) {
  return taskAction.action === "complete";
}

export function buildProgressNudgePrompt(task: {
  title: string;
  summary?: string | null;
  npcTaskId: string;
}) {
  const summaryLine = task.summary ? `현재 메모: ${task.summary}\n` : "";
  return [
    "시스템 알림입니다.",
    `진행 중인 태스크 \"${task.title}\"의 최근 진행 상황을 지금 바로 간단히 보고하세요.`,
    summaryLine.trim(),
    "아직 끝나지 않았다면 현재 상태를 한두 문장으로 설명하고, 반드시 ```json:task 코드블록으로 update 액션을 함께 포함하세요.",
    `task id는 \"${task.npcTaskId}\"를 그대로 사용하세요.`,
    "완료됐다면 complete 액션을 사용해도 됩니다.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildAutoExecutionPrompt(task: {
  title: string;
  summary?: string | null;
  npcTaskId: string;
}) {
  const summaryLine = task.summary ? `현재 메모: ${task.summary}\n` : "";
  return [
    "시스템 알림입니다.",
    `진행 중인 태스크 \"${task.title}\"를 지금 이어서 실제로 수행하세요.`,
    summaryLine.trim(),
    "다음 액션을 한 단계 진행한 뒤, 결과를 한두 문장으로 설명하세요.",
    "반드시 ```json:task 코드블록으로 update 또는 complete 액션을 포함하세요.",
    `task id는 \"${task.npcTaskId}\"를 그대로 사용하세요.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildManualTaskReportPrompt(task: {
  title: string;
  summary?: string | null;
  npcTaskId: string;
  status?: string | null;
}) {
  const summaryLine = task.summary ? `현재 메모: ${task.summary}\n` : "";
  const statusLine = task.status === "pending"
    ? "아직 시작 전이라면 지금 바로 착수하고, 첫 진행 상황을 짧게 보고하세요."
    : "사용자가 이 태스크의 최신 진행 상황 보고를 직접 요청했습니다.";

  return [
    "시스템 알림입니다.",
    statusLine,
    `대상 태스크: \"${task.title}\"`,
    summaryLine.trim(),
    "한두 문장으로 현재 상태를 설명하고, 반드시 ```json:task 코드블록으로 update 액션을 함께 포함하세요.",
    `task id는 \"${task.npcTaskId}\"를 그대로 사용하세요.`,
    "이미 완료되었다면 complete 액션으로 최종 보고를 하세요.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildResumeTaskExecutionPrompt(task: {
  title: string;
  summary?: string | null;
  npcTaskId: string;
}) {
  const summaryLine = task.summary ? `현재 메모: ${task.summary}\n` : "";
  return [
    "시스템 알림입니다.",
    `중단된 태스크 \"${task.title}\"를 지금 다시 이어서 실제로 수행하세요.`,
    summaryLine.trim(),
    "다음 액션을 한 단계 진행한 뒤, 결과를 한두 문장으로 설명하세요.",
    "반드시 ```json:task 코드블록으로 update 또는 complete 액션을 포함하세요.",
    `task id는 \"${task.npcTaskId}\"를 그대로 사용하세요.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildTaskActionStartMessage(
  task: { title: string },
  action: "request-report" | "resume",
) {
  if (action === "resume") {
    return `${task.title} 업무를 재개합니다.`;
  }
  return `${task.title} 업무를 처리하겠습니다.`;
}

export function buildCompletionReportRow(input: CompletionReportRowInput) {
  return buildQueuedReportRow({
    ...input,
    kind: "complete",
  });
}

export function buildQueuedReportRow(input: QueuedReportRowInput) {
  return {
    ...input,
    kind: input.kind ?? "complete",
    status: "pending" as const,
    createdAt: nowIso(),
    deliveredAt: null,
    consumedAt: null,
  };
}

export function getProgressNudgeCutoff(minutes: number, now = Date.now()) {
  return now - minutes * 60 * 1000;
}

export async function enqueueCompletionReport(
  db: unknown,
  schema: unknown,
  row: ReturnType<typeof buildCompletionReportRow>,
): Promise<QueuedReportRow | null> {
  return enqueueQueuedReport(db, schema, row);
}

export async function enqueueQueuedReport(
  db: unknown,
  schema: unknown,
  row: ReturnType<typeof buildQueuedReportRow>,
): Promise<QueuedReportRow | null> {
  const reportDb = asReportDb(db);
  const reportSchema = asReportSchema(schema);
  const [created] = await reportDb.insert(reportSchema.npcReports).values(row).returning();
  return normalizeReportRow(created);
}

export async function getPendingReportsForUserAndChannel(
  db: unknown,
  schema: unknown,
  input: PendingReportLookupInput,
): Promise<QueuedReportRow[]> {
  const reportDb = asReportDb(db);
  const reportSchema = asReportSchema(schema);
  const reports = reportSchema.npcReports;
  const rows = await reportDb
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.channelId, input.channelId),
        eq(reports.targetUserId, input.userId),
        isNull(reports.consumedAt),
      ),
    )
    .orderBy(asc(reports.createdAt));

  return (rows as ReportRow[]).map((row: ReportRow) => normalizeReportRow(row)).filter((row): row is QueuedReportRow => row !== null);
}

export function toReportReadyPayload(
  report: Pick<QueuedReportRow, "id" | "npcId" | "message" | "kind">,
  npcName?: string,
): ReportReadyPayload {
  return {
    reportId: report.id,
    npcId: report.npcId,
    npcName,
    message: report.message,
    kind: report.kind,
  };
}

export async function markReportDelivered(
  db: unknown,
  schema: unknown,
  reportId: string,
) {
  const reportDb = asReportDb(db);
  const reportSchema = asReportSchema(schema);
  const reports = reportSchema.npcReports;
  await reportDb
    .update(reports)
    .set({
      status: "delivered",
      deliveredAt: nowIso() as unknown as Date,
    })
    .where(eq(reports.id, reportId));
}

export async function markReportConsumed(
  db: unknown,
  schema: unknown,
  reportId: string,
) {
  const reportDb = asReportDb(db);
  const reportSchema = asReportSchema(schema);
  const reports = reportSchema.npcReports;
  await reportDb
    .update(reports)
    .set({
      status: "consumed",
      consumedAt: nowIso() as unknown as Date,
    })
    .where(eq(reports.id, reportId));
}

export function buildGatewayConfig(input: unknown) {
  const source = parseGatewayConfig(input);

  return {
    url: typeof source?.url === "string" ? source.url.trim() || null : null,
    token: typeof source?.token === "string" ? source.token.trim() || null : null,
    taskAutomation: getTaskAutomationConfig(source),
  };
}

export function mergeGatewayConfig(existingConfig: unknown, patch: unknown) {
  const existing = buildGatewayConfig(existingConfig);
  const update = parseGatewayConfig(patch);
  const updateTaskAutomation = asRecord(update?.taskAutomation);
  const existingTaskAutomation = existing.taskAutomation;
  const hasUrl = update ? Object.hasOwn(update, "url") : false;
  const hasToken = update ? Object.hasOwn(update, "token") : false;

  return {
    url: hasUrl
      ? (update?.url === null
        ? null
        : typeof update?.url === "string"
          ? update.url.trim() || null
          : existing.url)
      : existing.url,
    token: hasToken
      ? (update?.token === null
        ? null
        : typeof update?.token === "string"
          ? update.token.trim() || null
          : existing.token)
      : existing.token,
    taskAutomation: {
      autoProgressNudgeEnabled:
        typeof updateTaskAutomation?.autoProgressNudgeEnabled === "boolean"
          ? updateTaskAutomation.autoProgressNudgeEnabled
          : existingTaskAutomation.autoProgressNudgeEnabled,
      autoProgressNudgeMinutes:
        typeof updateTaskAutomation?.autoProgressNudgeMinutes === "number"
          ? updateTaskAutomation.autoProgressNudgeMinutes
          : existingTaskAutomation.autoProgressNudgeMinutes,
      autoProgressNudgeMax:
        typeof updateTaskAutomation?.autoProgressNudgeMax === "number"
          ? updateTaskAutomation.autoProgressNudgeMax
          : existingTaskAutomation.autoProgressNudgeMax,
      reportWaitSeconds:
        typeof updateTaskAutomation?.reportWaitSeconds === "number"
          ? updateTaskAutomation.reportWaitSeconds
          : existingTaskAutomation.reportWaitSeconds,
    },
  };
}
