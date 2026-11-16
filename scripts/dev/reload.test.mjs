import test from "node:test";
import assert from "node:assert/strict";
import { createReloadCoordinator, dependencyOrder } from "./reload.mjs";

test("backend reloads preserve the stable web proxy; SDK reloads still restart it", async () => {
  const specs = [{ id: "web", dependsOn: ["sync", "sdk"], reloadDependsOn: ["sdk"] }, { id: "sync", dependsOn: ["api"] }, { id: "api" }, { id: "sdk" }];
  assert.deepEqual(
    dependencyOrder(specs).map(({ id }) => id),
    ["api", "sync", "sdk", "web"],
  );
  const events = [];
  const coordinator = createReloadCoordinator({ serviceSpecs: specs, restart: async (id, action) => events.push(`${action}:${id}`) });
  await coordinator.request(["sync"]);
  assert.deepEqual(events.splice(0), ["stop:sync", "start:sync"]);
  await coordinator.request(["api"]);
  assert.deepEqual(events.splice(0), ["stop:sync", "stop:api", "start:api", "start:sync"]);
  await coordinator.request(["sdk"]);
  assert.deepEqual(events, ["stop:web", "stop:sdk", "start:sdk", "start:web"]);
});
