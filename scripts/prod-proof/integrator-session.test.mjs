import assert from "node:assert/strict";
import test from "node:test";
import { createIntegratorSession } from "./integrator-session.mjs";

function fixture() {
  const calls = [];
  const session = createIntegratorSession({
    createEpisode: async () => {
      calls.push("create");
      return { id: "episode" };
    },
    admit: async (episode, id) => {
      calls.push(["admit", episode.id, id]);
      return { participant: { id }, access: { generation: 1 } };
    },
    refresh: async (episode, admission, request) => {
      calls.push(["refresh", episode.id, admission.participant.id, request]);
      return { generation: admission.access.generation + 1 };
    },
  });
  return { session, calls };
}

test("browser setup beyond the three-minute empty linger creates no Episode", async (t) => {
  // Observed failure: creation 12:19:56.937Z; first access 12:23:05Z.
  t.mock.timers.enable({ apis: ["Date"] });
  t.mock.timers.setTime(Date.parse("2026-01-01T12:19:56.937Z"));
  const { session, calls } = fixture();
  await assert.rejects(session.getAccess(1, {}), /Prepare both/);
  session.markReady(1);
  t.mock.timers.tick(188_063);
  await assert.rejects(session.getAccess(1, {}), /Prepare both/);
  assert.deepEqual(calls, []);
  session.markReady(2);
  assert.equal(session.ready, true);
  assert.deepEqual(calls, [], "readiness alone must not create an Episode");
  assert.deepEqual(await session.getAccess(1, {}), { generation: 1 });
  assert.deepEqual(calls, ["create", ["admit", "episode", 1]]);
});

test("simultaneous first Joins create one Episode and one admission per client", async () => {
  const { session, calls } = fixture();
  session.markReady(1);
  session.markReady(2);
  await Promise.all([session.getAccess(1, {}), session.getAccess(2, {})]);
  assert.deepEqual(calls, ["create", ["admit", "episode", 1], ["admit", "episode", 2]]);
});

test("access refreshes serialize per client and keep their original admission", async () => {
  const { session, calls } = fixture();
  session.markReady(1);
  session.markReady(2);
  const grants = await Promise.all([session.getAccess(1, {}), session.getAccess(1, { replaceMediaConnection: true }), session.getAccess(1, { replaceMediaConnection: false })]);
  assert.deepEqual(
    grants.map((grant) => grant.generation),
    [1, 2, 3],
  );
  assert.deepEqual(calls.slice(2), [
    ["refresh", "episode", 1, { replaceMediaConnection: true }],
    ["refresh", "episode", 1, { replaceMediaConnection: false }],
  ]);
});

test("failed Episode creation stays failed without creating another Episode", async () => {
  let creates = 0;
  const session = createIntegratorSession({
    createEpisode: async () => {
      creates++;
      throw new Error("creation failed");
    },
    admit: () => assert.fail("must not admit"),
    refresh: () => assert.fail("must not refresh"),
  });
  session.markReady(1);
  session.markReady(2);
  await assert.rejects(session.getAccess(1, {}), /creation failed/);
  await assert.rejects(session.getAccess(2, {}), /creation failed/);
  assert.equal(creates, 1);
});
