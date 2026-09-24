import assert from "node:assert/strict";
import test from "node:test";

import type { PluginInfo } from "./deskrpg-plugin-types";
import {
  KANBAN_VIEWS_MIN_VERSION,
  kanbanViewsGate,
  supportsKanbanViews,
} from "./plugin-capability";

function info(capabilities: string[], version = "0.11.0"): PluginInfo {
  return {
    plugin: "deskrpg",
    version,
    routes: [],
    capabilities,
    timezone: null,
    kanban: { dispatcher_present: true, attachments: true },
  } as PluginInfo;
}

test("the capability is the source of truth for availability — the version is not checked", () => {
  // Judging by version creates the undiagnosable state "0.11.0 but 404".
  assert.equal(supportsKanbanViews(info(["kanban", "kanban_views"], "0.9.0")), true);
  assert.equal(supportsKanbanViews(info(["kanban"], "9.9.9")), false);
});

test("no_info when info is missing, missing_capability when only the capability is missing", () => {
  assert.deepEqual(kanbanViewsGate(null), {
    ok: false,
    minVersion: KANBAN_VIEWS_MIN_VERSION,
    reason: "no_info",
    missing: ["kanban_views"],
  });
  assert.deepEqual(kanbanViewsGate(info(["kanban"])), {
    ok: false,
    minVersion: KANBAN_VIEWS_MIN_VERSION,
    reason: "missing_capability",
    missing: ["kanban_views"],
  });
});

test("passes when present", () => {
  assert.deepEqual(kanbanViewsGate(info(["kanban", "kanban_views"])), { ok: true });
});

test("kept separate from the automation minimum version — its absence does not lock kanban entirely", async () => {
  const { AUTOMATION_MIN_VERSION, meetsAutomationContract } = await import("./plugin-capability");
  const withoutViews = info(["kanban", "cron", "events"], AUTOMATION_MIN_VERSION);
  assert.equal(meetsAutomationContract(withoutViews).ok, true, "칸반은 계속 돌아야 한다");
  assert.equal(supportsKanbanViews(withoutViews), false);
});
