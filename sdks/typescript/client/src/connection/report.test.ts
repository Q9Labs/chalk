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
  const create = (upload?: () => Promise<void>) =>
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
        await upload?.();
        if (failures-- > 0) throw new TypeError("network");
      },
    });
  return {
    create,
    sent,
    access,
    advance: (ms = 61000) => {
      now += ms;
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
  await Promise.resolve();
  await Promise.resolve();
};

describe("automatic connection reports", () => {
  it("uploads stuck receive facts without identities or private text", async () => {
    const test = fixture();
    const reporter = test.create();
    reporter.recordTransport({
      event: "audio_receive_stuck",
      source: "screen_audio",
      receive_state: "element_bound",
      track_state: "live",
      element_state: "paused",
      play_result: "NotAllowedError",
      media_error_kind: "network",
      media_error_step: "sfu_tracks",
      duration_ms: 11000,
      ...{ publicationId: "private-publication", participantId: "private-person", trackId: "private-track", name: "private-name" },
    });
    await settled();
    expect(test.sent[0]?.trigger).toBe("audio_receive_stuck");
    expect(test.sent[0]?.events[0]).toMatchObject({ source: "screen_audio", receive_state: "element_bound", track_state: "live", element_state: "paused", play_result: "NotAllowedError", media_error_kind: "network", media_error_step: "sfu_tracks", duration_ms: 11000 });
    expect(JSON.stringify(test.sent)).not.toMatch(/private|participantId|publicationId|trackId/);
    reporter.dispose();
  });
  it("retains only the latest summary and bounds fixed-key counts with independent five-minute spacing", async () => {
    const test = fixture();
    const reporter = test.create();
    reporter.recordTransport({ event: "sync_socket_open" });
    reporter.recordTransport({ event: "audio_receive_summary", receive_counts: { playing: 1 } });
    await settled();
    test.advance(299999);
    reporter.recordTransport({ event: "audio_receive_summary", receive_counts: { playing: 2 } });
    expect(test.sent).toHaveLength(1);
    test.advance(1);
    reporter.recordTransport({ event: "audio_receive_summary", receive_counts: { playing: 10001, announced: -1, ...{ privateId: 1 } } });
    await settled();
    expect(test.sent).toHaveLength(2);
    expect(test.sent[1]?.events).toEqual([{ event: "audio_receive_summary", elapsed_ms: 300000, receive_counts: { playing: 10000, announced: 0 } }]);
    expect(test.sent.every((r) => r.events.every((e) => e.event.startsWith("audio_receive_")))).toBe(true);
    expect(JSON.stringify(test.sent)).not.toContain("private");
    reporter.dispose();
  });
  it.each(["completed", "offline", "inflight"] as const)("a %s summary never consumes or blocks the failure cooldown", async (mode) => {
    const test = fixture(mode !== "offline");
    const upload = Promise.withResolvers<void>();
    const reporter = test.create(mode === "inflight" ? () => (test.sent.length === 1 ? upload.promise : Promise.resolve()) : undefined);
    reporter.recordTransport({ event: "audio_receive_summary", receive_counts: { playing: 1 } });
    if (mode === "completed") await settled();
    fail(reporter);
    if (mode === "offline") test.reconnect();
    upload.resolve();
    await vi.waitFor(() => expect(test.sent.at(-1)?.trigger).toBe("join_failed"));
    expect(test.sent.filter((r) => r.trigger === "join_failed")).toHaveLength(1);
    reporter.dispose();
  });
  it("replaces an unsent offline summary with the latest counts", async () => {
    const test = fixture(false);
    const reporter = test.create();
    reporter.recordTransport({ event: "audio_receive_summary", receive_counts: { playing: 1 } });
    reporter.recordTransport({ event: "audio_receive_summary", receive_counts: { playing: 2 } });
    test.reconnect();
    await settled();
    expect(test.sent[0]?.events).toEqual([{ event: "audio_receive_summary", elapsed_ms: 0, receive_counts: { playing: 2 } }]);
    reporter.dispose();
  });
  it("automatically uploads bounded media mismatch facts without device text", async () => {
    const test = fixture();
    const reporter = test.create();
    reporter.recordTransport({ event: "media_projection_mismatch", source: "microphone", publication_state: "on", projection_state: "off", duration_ms: 2750, attempt: 2, outcome: "started" });
    await settled();
    expect(test.sent).toEqual([{ version: 1, trigger: "media_projection_mismatch", events: [{ event: "media_projection_mismatch", elapsed_ms: 0, source: "microphone", publication_state: "on", projection_state: "off", duration_ms: 2750, attempt: 2, outcome: "started" }] }]);
    reporter.dispose();
  });
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
  it.each([false, true])("retries a reconnect received during an active upload, with retry failure %s", async (retryFails) => {
    const firstUpload = Promise.withResolvers<void>();
    const test = fixture();
    const reporter = test.create(() => {
      if (test.sent.length === 1) return firstUpload.promise;
      if (retryFails) return Promise.reject(new TypeError("network"));
      return Promise.resolve();
    });
    try {
      fail(reporter);
      expect(test.sent).toHaveLength(1);
      test.reconnect();
      test.reconnect();
      firstUpload.reject(new TypeError("interrupted upload"));
      await vi.waitFor(() => expect(test.sent).toHaveLength(2));
      await vi.waitFor(() => expect(test.listening()).toBe(false));
      expect(test.sent[1]).toEqual(test.sent[0]);
      test.reconnect();
      await settled();
      expect(test.sent).toHaveLength(2);
    } finally {
      reporter.dispose();
    }
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
