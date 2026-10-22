import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Uses the public server SDK and real API/Postgres/Sync. SQL inspects durable
// state, advances leases, and simulates a legacy Sync write for rollback coverage.
export async function proveServerSeats({ repository, apiOrigin, syncOrigin, tenantId }) {
  const { createChalkServerClient } = await import(`${repository}/sdks/typescript/client/dist/server/index.js`);
  const client = createChalkServerClient({ apiBaseURL: apiOrigin, tenantId, apiKey: "fixture-dashboard-service-token-not-a-secret" });
  const space = await client.spaces.create({
    admissionPolicy: { mode: "open" },
    defaultEpisodeDurationSeconds: 3600,
    lingerWindowSeconds: 0,
    maximumEpisodeDurationSeconds: 3600,
    mediaPlane: "cf_sfu",
    name: "Synthetic server SDK joins",
    slug: `seat-proof-${crypto.randomUUID()}`,
    recordingPolicy: "disabled",
  });
  const spaceId = space.id;
  const episodeId = (await client.episodes.create(spaceId, {}, { idempotencyKey: crypto.randomUUID() })).id;
  const sql = (query) => execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-Atc", query], { encoding: "utf8" }).trim();
  const state = (id) => sql(`select p.status||':'||coalesce(s.state,'legacy')||':'||(p.first_joined_at is not null)::text from participants p left join participant_join_seats s on s.participant_id=p.id where p.id='${id}'`);
  async function waitFor(expected, read) {
    for (let i = 0; i < 100; i++) {
      if (read() === expected) return;
      await delay(50);
    }
    assert.equal(read(), expected);
  }
  const expire = (id) => sql(`update participant_join_seats set expires_at=now()-interval '1 second' where participant_id='${id}'; update sync_lifecycle_intents set next_attempt_at=now() where participant_id='${id}' and status='pending'`);
  async function attendance() {
    const response = await fetch(`${apiOrigin}/v1/tenants/${tenantId}/spaces/${spaceId}/episodes/${episodeId}/attendance`, { headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret" } });
    assert.equal(response.status, 200);
    return (await response.json()).participants;
  }
  async function cancel(access, token = access.media.token) {
    const s = access.subject;
    return fetch(`${apiOrigin}/v1/tenants/${s.tenant_id}/spaces/${s.space_id}/episodes/${s.episode_id}/participants/${s.participant_id}/cancel-join`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  }
  async function rejectOldHello(access) {
    const ws = new WebSocket(syncOrigin);
    try {
      const rejected = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("stale Sync hello was not rejected")), 5000);
        ws.addEventListener(
          "close",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
        ws.addEventListener("message", ({ data }) => {
          if (JSON.parse(data).type === "welcome") {
            clearTimeout(timeout);
            reject(new Error("stale Sync token confirmed a retried seat"));
          }
        });
      });
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
      ws.send(JSON.stringify({ type: "hello", protocol: 1, token: access.sync.token, streams: { control: { cursor: null }, media: { cursor: null }, presence: { cursor: null }, requests: { cursor: null } } }));
      await rejected;
    } finally {
      ws.close();
    }
  }
  const reservations = () => sql(`select snapshot_reserved_bytes||':'||lifecycle_reserved_events||':'||lifecycle_reserved_bytes||':'||lifecycle_reserved_intents||':'||lifecycle_reserved_intent_bytes from sync_episode_control where episode_id='${episodeId}'`);
  for (const role of ["owner", "collaborator"]) {
    const baseline = reservations();
    const key = crypto.randomUUID();
    const input = { participantId: crypto.randomUUID(), name: `Seat proof ${role}`, role };
    const admit = () => client.participants.admit(spaceId, episodeId, input, { idempotencyKey: key });
    const pending = await admit();
    assert(pending.access, "open admission must return a participant access grant");
    const id = pending.participant.id;
    assert.equal(sql(`select (expires_at > now()+interval '60 seconds' and expires_at <= now()+interval '2 minutes')::text from participant_join_seats where participant_id='${id}'`), "true", "pending admission has a bounded lease");
    assert(!(await attendance()).some((person) => person.participant_id === id));
    await delay(300);
    assert.equal(state(id), "joining:pending:false", "admission with no socket must not become attendance");
    sql(`update participant_join_seats set expires_at=now()+interval '2 seconds' where participant_id='${id}'; update sync_lifecycle_intents set next_attempt_at=now()+interval '2 seconds' where participant_id='${id}' and status='pending'`);
    const pendingRetry = await admit();
    assert.equal(pendingRetry.participant.id, id, "same-page Retry must reuse one seat");
    assert.equal(
      sql(`select (s.expires_at > now()+interval '60 seconds' and i.next_attempt_at=s.expires_at)::text from participant_join_seats s join sync_lifecycle_intents i using(participant_id) where s.participant_id='${id}' and i.intent_name='participant_joined'`),
      "true",
      "Retry renews the seat and reaper deadlines",
    );
    await rejectOldHello(pending.access);
    assert.equal(state(id), "joining:pending:false", "the previous pending attempt cannot confirm the renewed seat");
    // Tab closes after HTTP admission, so no client cleanup can run.
    expire(id);
    await waitFor("left:expired:false", () => state(id));
    assert.equal((await cancel(pending.access)).status, 200, "late cleanup is idempotent");
    const retried = await admit();
    assert.equal(retried.participant.id, id, "expired unresolved admission must rearm the same seat");
    await rejectOldHello(pendingRetry.access);
    assert.equal(state(id), "joining:pending:false", "an expired attempt cannot confirm the rearmed seat");
    assert.notEqual(retried.access.media.client_payload.connectionId, pending.access.media.client_payload.connectionId);
    const currentAttempt = sql(`select generation||':'||media_connection_id from participants where id='${id}'`);
    const staleCleanup = await cancel(pending.access);
    assert.equal(staleCleanup.status, 200);
    assert.deepEqual(await staleCleanup.json(), { cancelled: false }, "stale cleanup must not authorize a fresh admission");
    await assert.rejects(() => client.participants.issueAccess(spaceId, episodeId, id, { participantGeneration: pending.access.subject.participant_generation, replaceMediaConnection: true }), { status: 409, code: "participant.generation_mismatch" });
    assert.equal(sql(`select generation||':'||media_connection_id from participants where id='${id}'`), currentAttempt, "stale access recovery must not fence the newer attempt");
    assert.equal(state(id), "joining:pending:false", "late cleanup must not cancel the retry generation");
    assert.equal((await cancel(retried.access, "invalid-token")).status, 401);
    const forgedRoute = `${apiOrigin}/v1/tenants/${tenantId}/spaces/${spaceId}/episodes/${episodeId}/participants/${crypto.randomUUID()}/cancel-join`;
    assert.equal((await fetch(forgedRoute, { method: "POST", headers: { Authorization: `Bearer ${retried.access.media.token}` } })).status, 403, "a signed grant cannot cancel another seat");
    expire(id); // Lost HTTP cleanup is covered by the lease.
    await waitFor("left:expired:false", () => state(id));
    const final = await admit();
    assert.equal((await cancel(final.access)).status, 200);
    assert.equal((await cancel(final.access)).status, 200);
    assert.equal(state(id), "left:cancelled:false");
    assert.equal(reservations(), baseline, "expiry and cancellation must release all pending-seat reservations");
    const joined = await admit();
    await rejectOldHello(final.access);
    assert.equal(state(id), "joining:pending:false", "a cancelled attempt cannot confirm the rearmed seat");
    const ws = new WebSocket(syncOrigin);
    try {
      const ready = new Promise((resolve, reject) => {
        ws.addEventListener("message", ({ data }) => {
          const frame = JSON.parse(data);
          if (frame.type === "welcome" && frame.mode === "snapshot") {
            ws.send(JSON.stringify({ type: "recovery_ack", recovery_id: frame.recovery_id, revision: frame.head.revision, state_digest: frame.head.state_digest }));
          }
          if (frame.type === "projection_snapshot" && frame.stream === "presence") resolve();
          if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        });
        ws.addEventListener("error", reject, { once: true });
      });
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
      ws.send(JSON.stringify({ type: "hello", protocol: 1, token: joined.access.sync.token, streams: { control: { cursor: null }, media: { cursor: null }, presence: { cursor: null }, requests: { cursor: null } } }));
      await waitFor("active:joined:true", () => state(id));
      await ready;
      assert.equal(sql(`select count(*) from sync_control_events where episode_id='${episodeId}' and event_name='participant_joined' and payload->>'participant_id'='${id}'`), "1");
      assert.equal((await cancel(joined.access)).status, 200, "pending cancellation cannot remove a confirmed join");
      assert.equal(state(id), "active:joined:true");
      expire(id);
      await delay(250);
      assert.equal(state(id), "active:joined:true", "lease cannot reap confirmed joins");
      assert.equal((await attendance()).filter((person) => person.participant_id === id).length, 1);
      assert.equal(sql(`select count(*) from participants where id='${id}'`), "1");
      if (role === "owner") {
        // An older Sync binary confirms attendance but does not know the seat table.
        sql(`update participant_join_seats set state='pending' where participant_id='${id}'`);
      }
      ws.send(JSON.stringify({ type: "operation", command_id: crypto.randomUUID(), name: "participant_leave", payload: {} }));
      await waitFor("left:left:true", () => state(id));
      await assert.rejects(admit, "a confirmed departure must not rearm an applied admission");
      assert.equal(state(id), "left:left:true");
    } finally {
      ws.close();
    }
    console.log(`PASS server SDK ${role}: pending, Retry, tab loss, expiry, cleanup loss, stale cleanup, confirmation once`);
  }
}
