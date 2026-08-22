export declare const TASK_CORE_PROMPT: string;
export declare const TASK_REMINDER: string;
export declare function buildTaskCorePrompt(locale?: string | null): string;
export declare function buildTaskReminder(locale?: string | null): string;
export declare function injectTaskPrompt(userIdentity: string, locale?: string | null): string;
export declare function withTaskReminder(userMessage: string, locale?: string | null): string;
export declare function normalizeTaskPromptLocale(
  locale?: string | null,
): "en" | "ko" | "ja" | "zh";
export declare function buildTaskSessionPrompt(
  task: {
    title: string;
    npcTaskId: string;
    status: string;
    summary: string | null;
    createdAt: string;
  },
  locale?: string | null,
): string;
