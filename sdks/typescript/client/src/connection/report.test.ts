import { describe, expect, it, vi } from "vitest";
import { parseParsedAccessGrant } from "../access/grant";
import { ConnectionReporter, type ConnectionReport } from "./report";

let participant = 0;
function fixture(online = true) {
  const credential = (audience: string) => `${btoa('{"alg":"EdDSA"}')}.${btoa(JSON.stringify({ aud: audience }))}.fixture`;
  const access = parseParsedAccessGrant({
    subject: { tenant_id: "tenant", space_id: "space", episode_id: "episode", participant_id: `report-test-${++participant}`, participant_generation: 1 },
    sync: { token: credential("chalk-sync"), expires_at: "2099-01-01T00:00:00Z" },
    media: { token: credential("chalk-media"), expires_at: "2099-01-01T00:00:00Z", provider: "cloudflare_sfu", client_payload: { connectionId: "private-connection", stunServer: "stun:private.example" } },
  });
  let now = 0;
  let listener: (() => void) | undefined;
  const sent: ConnectionReport[] = [];
  let failures = 0;
  const create = () =>
    new ConnectionReporter({
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      now: () => now,
      access: () => access,
      online: () => online,
      subscribeOnline: (callback) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
      send: async (_access, report) => {
        sent.push(report);
        if (failures-- > 0) throw new TypeError("network");
      },
    });
  return {
    create,
    sent,
    access,
    advance: () => {
      now += 61000;
    },
    fail: () => {
      failures = 10;
    },
    reconnect: () => {
      online = true;
      listener?.();
    },
    listening: () => !!listener,
  };
}
const fail = (reporter: ConnectionReporter) => reporter.recordDiagnostic({ event: "connection_failed", state: "joining", epoch: 1, code: "sync_start_failed", sync: { stage: "hello", opened: true, closeCode: 1006, closeReason: "Bearer private@example.test 192.0.2.1", durationMs: 30000 } });
const settled = async () => {
  await vi.dynamicImportSettled();
  await Promise.resolve();
  await Promise.resolve();
};

describe("automatic connection reports", () => {
  it("sends nothing for successful joins; failures send only a bounded numeric/enum projection", async () => {
    const test = fixture();
    const reporter = test.create();
    for (let i = 0; i < 1000; i++) reporter.recordDiagnostic({ event: "space_join_span", state: "joining", epoch: i, step: "join", spanId: "private-name-and-token", outcome: "succeeded", durationMs: i });
    expect(test.sent).toHaveLength(0);
    fail(reporter);
    await settled();
    expect(test.sent).toHaveLength(1);
    const report = test.sent[0];
    expect(report?.events).toHaveLength(64);
    expect(report?.trigger).toBe("join_failed");
    expect(report?.events.at(-1)?.close_code).toBe(1006);
    const body = JSON.stringify(report);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(32768);
    for (const secret of [test.access.media.token, "private", "192.0.2.1", "Bearer", test.access.subject.participantId, "spanId", "epoch"]) expect(body).not.toContain(secret);
    reporter.dispose();
  });
  it("shares its cooldown across connections for the same participant", async () => {
    const test = fixture();
    const first = test.create();
    const second = test.create();
    fail(first);
    await settled();
    fail(second);
    await settled();
    expect(test.sent).toHaveLength(1);
    test.advance();
    fail(second);
    await settled();
    expect(test.sent).toHaveLength(2);
    first.dispose();
    second.dispose();
  });
  it("keeps one offline report and flushes it once when connectivity returns", async () => {
    const test = fixture(false);
    const reporter = test.create();
    reporter.recordTransport({ event: "sync_socket_close", close_code: 1006, duration_ms: 60000, heartbeat_gap_ms: 60000 });
    reporter.recordDiagnostic({ event: "recovery_exhausted", state: "reconnecting", epoch: 1, code: "sync_recovery_exhausted", attempt: 3 });
    fail(reporter);
    expect(test.sent).toHaveLength(0);
    test.reconnect();
    await settled();
    test.reconnect();
    await settled();
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]?.trigger).toBe("recovery_exhausted");
    expect(test.sent[0]?.events[0]?.heartbeat_gap_ms).toBe(60000);
    expect(test.listening()).toBe(false);
    reporter.dispose();
  });
  it("bounds failed upload retries and removes its reconnect listener on disposal", async () => {
    const test = fixture();
    test.fail();
    const reporter = test.create();
    fail(reporter);
    await settled();
    test.reconnect();
    await settled();
    test.reconnect();
    await settled();
    expect(test.sent).toHaveLength(2);
    expect(test.listening()).toBe(false);
    const offline = fixture(false);
    const discarded = offline.create();
    fail(discarded);
    discarded.dispose();
    offline.reconnect();
    await settled();
    expect(offline.sent).toHaveLength(0);
    expect(offline.listening()).toBe(false);
    reporter.dispose();
  });
});
