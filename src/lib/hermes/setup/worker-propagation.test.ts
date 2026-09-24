import test from "node:test";
import assert from "node:assert/strict";

import {
  inheritedWorkerPropagation,
  runWorkerPropagation,
  setupWorkerPluginApplies,
} from "./worker-propagation";

test("update carries over as on only for gateways with links remaining but the setting off", () => {
  assert.equal(
    inheritedWorkerPropagation({ workerLinked: true, workerPropagation: "disabled" }),
    true,
  );
  // If already on there's nothing to write. If there are no links, the operator never turned it on — keep the
  // default off.
  assert.equal(
    inheritedWorkerPropagation({ workerLinked: true, workerPropagation: "enabled" }),
    false,
  );
  assert.equal(
    inheritedWorkerPropagation({ workerLinked: false, workerPropagation: "disabled" }),
    false,
  );
  // Unknown values, like an old helper response, are left alone.
  assert.equal(inheritedWorkerPropagation({}), false);
});

function deps(propagation: "enabled" | "disabled", ensureOk = true) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      setFlag: async (enabled: boolean) => {
        calls.push(`set:${enabled}`);
        return propagation;
      },
      ensure: async () => {
        calls.push("ensure");
        return ensureOk
          ? {
              ok: true as const,
              data: { results: [{ profile: "sophie", link: "created", enabled: "added" }] },
            }
          : { ok: false as const, status: 409, failure: { code: "worker_propagation_disabled" } };
      },
      refreshCache: async () => {
        calls.push("refresh");
      },
    },
  };
}

test("enabling writes the flag, then calls the existing apply and refills the cache", async () => {
  const { calls, deps: d } = deps("enabled");
  const res = await runWorkerPropagation(true, d);
  assert.deepEqual(calls, ["set:true", "ensure", "refresh"]);
  assert.deepEqual(res, {
    propagation: "enabled",
    results: [{ profile: "sophie", link: "created", enabled: "added" }],
  });
});

test("even if apply fails, the flag state is reported and the plugin code is carried as-is", async () => {
  const { deps: d } = deps("enabled", false);
  assert.deepEqual(await runWorkerPropagation(true, d), {
    propagation: "enabled",
    errorCode: "worker_propagation_disabled",
  });
});

test("disabling doesn't call apply and only refills the cache — the plugin doesn't delete existing links", async () => {
  const { calls, deps: d } = deps("disabled");
  assert.deepEqual(await runWorkerPropagation(false, d), { propagation: "disabled" });
  assert.deepEqual(calls, ["set:false", "refresh"]);
});

test("a cache refresh failure doesn't mask the result", async () => {
  const { deps: d } = deps("disabled");
  const res = await runWorkerPropagation(false, {
    ...d,
    refreshCache: async () => {
      throw new Error("probe failed");
    },
  });
  assert.deepEqual(res, { propagation: "disabled" });
});

test("the wizard's apply runs only when enable was chosen, it actually turned on, and the plugin supports apply", () => {
  const info = { capabilities: ["kanban", "worker_plugin"] };
  assert.equal(setupWorkerPluginApplies(true, "enabled", info), true);
  assert.equal(setupWorkerPluginApplies(undefined, "enabled", info), false);
  assert.equal(setupWorkerPluginApplies(false, "enabled", info), false);
  assert.equal(setupWorkerPluginApplies(true, "disabled", info), false);
  assert.equal(setupWorkerPluginApplies(true, "enabled", { capabilities: ["kanban"] }), false);
  assert.equal(setupWorkerPluginApplies(true, "enabled", null), false);
});
