/**
 * The **single source of truth** for the `deskrpg-hermes-plugin` install command.
 *
 * Kanban (`kanban-view-model.ts`) and cron (`cron-api.ts`) used to each hold the same string,
 * and now the gateway onboarding guide shows the same command too. Instead of making a third copy,
 * we gather it here — if the repository address changes, there is one place to fix.
 */
export const PLUGIN_INSTALL_COMMAND =
  "hermes plugins install https://github.com/dandacompany/deskrpg-hermes-plugin && hermes plugins enable deskrpg";

/** The official Hermes Agent repository — where users who have not started a gateway yet should go. */
export const HERMES_AGENT_REPO_URL = "https://github.com/NousResearch/hermes-agent";
