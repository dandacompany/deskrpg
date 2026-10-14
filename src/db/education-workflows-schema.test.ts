import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureEducationWorkflows } = require("./sqlite-education-workflows.js");

test("education workflow tables are created idempotently with unique events and task links", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);");
  ensureEducationWorkflows(db);
  ensureEducationWorkflows(db);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  assert.ok(tables.some((row) => row.name === "education_workflows"));
  assert.ok(tables.some((row) => row.name === "education_workflow_events"));

  db.prepare(`INSERT INTO education_workflows
    (id,title,request_text,source,idempotency_key,created_at,updated_at)
    VALUES ('w1','주제','요청','slack','k1',datetime('now'),datetime('now'))`).run();
  db.prepare(`INSERT INTO education_workflow_events
    (id,workflow_id,version,action,actor,source,created_at)
    VALUES ('e1','w1',0,'created','sophie','slack',datetime('now'))`).run();
  assert.throws(() => db.prepare(`INSERT INTO education_workflow_events
    (id,workflow_id,version,action,actor,source,created_at)
    VALUES ('e1','w1',0,'created','sophie','slack',datetime('now'))`).run(), /UNIQUE constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO education_workflow_events
    (id,workflow_id,version,action,actor,source,created_at)
    VALUES ('e2','missing',1,'updated','sophie','slack',datetime('now'))`).run(), /FOREIGN KEY constraint failed/);
});
