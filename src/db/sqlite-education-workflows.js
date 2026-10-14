"use strict";

const EDUCATION_WORKFLOWS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS education_workflows (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    request_text TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'topic_recommendation',
    status TEXT NOT NULL DEFAULT 'active',
    version INTEGER NOT NULL DEFAULT 0,
    state_json TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL,
    external_session_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS education_workflows_updated_idx ON education_workflows(updated_at);
  CREATE TABLE IF NOT EXISTS education_workflow_events (
    id TEXT PRIMARY KEY NOT NULL,
    workflow_id TEXT NOT NULL REFERENCES education_workflows(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    source TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS education_workflow_events_workflow_version_idx
    ON education_workflow_events(workflow_id, version);
`;

function ensureEducationWorkflows(sqlite) {
  sqlite.exec(EDUCATION_WORKFLOWS_SCHEMA);
}

module.exports = { EDUCATION_WORKFLOWS_SCHEMA, ensureEducationWorkflows };
