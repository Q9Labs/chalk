import { expect } from "vitest";
import { TelemetryOutbox } from "./outbox";
import type { PlatformChange, TelemetryEvent, TelemetryPlatform, TelemetrySend, TelemetrySendResult } from "./types";

type Answer = TelemetrySendResult | "network_error";

/** A platform that runs on the test clock and answers each POST from a script. The default answer is a 200. */
export function createTestTelemetryPlatform(options: { readonly now?: () => number } = {}) {
  const listeners = new Set<(change: PlatformChange) => void>();
  const requests: { readonly send: TelemetrySend; readonly events: TelemetryEvent[]; readonly status: number | "network_error" }[] = [];
  const accepted: TelemetryEvent[] = [];
  const answers: Answer[] = [];
  let ids = 0;
  const state = { online: true, hidden: false };
  const platform: TelemetryPlatform = {
    now: options.now ?? (() => Date.now()),
    uuid: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    online: () => state.online,
    hidden: () => state.hidden,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async (send) => {
      const body: { readonly events: TelemetryEvent[] } = JSON.parse(send.body);
      const answer = answers.shift() ?? { status: 200, retryAfterMs: 0 };
      requests.push({ send, events: body.events, status: answer === "network_error" ? answer : answer.status });
      if (answer === "network_error") throw new TypeError("network error");
      if (answer.status >= 200 && answer.status < 300) accepted.push(...body.events);
      return answer;
    },
  };
  return {
    platform,
    requests,
    /** Every event a 2xx answer took, in the order the server saw them. */
    accepted,
    state,
    /** The next POSTs get these answers, one each, in order. */
    answer: (...next: Answer[]) => answers.push(...next),
    emit: (change: PlatformChange) => {
      if (change === "offline") state.online = false;
      if (change === "online") state.online = true;
      if (change === "hidden" || change === "background") state.hidden = true;
      if (change === "visible" || change === "foreground") state.hidden = false;
      for (const listener of [...listeners]) listener(change);
    },
  };
}

/** An outbox over the test platform, bound to a credential that stays valid. */
export function createTestOutbox(options: { readonly now?: () => number; readonly random?: () => number } = {}) {
  const harness = createTestTelemetryPlatform(options);
  const outbox = new TelemetryOutbox({ platform: harness.platform, endpoint: (tenantId) => `https://api.test/v1/tenants/${tenantId}/telemetry`, random: options.random ?? (() => 0.5) });
  outbox.bind({ current: () => ({ tenantId: "tenant", token: "token", expiresAt: Date.now() + 3_600_000 }), refresh: async () => undefined });
  return { ...harness, outbox };
}

/** What the server checks of one client session: `seq` only rises, and every hole is a drop the client counted in a `telemetry_dropped` event. */
export function expectUnbrokenSequence(events: readonly TelemetryEvent[]): void {
  const seqs = events.map((event) => event.seq);
  seqs.forEach((seq, index) => {
    if (index > 0) expect(seq).toBeGreaterThan(seqs[index - 1] ?? -1);
  });
  const holes = (seqs.at(-1) ?? -1) + 1 - seqs.length;
  const counted = events.reduce((sum, event) => sum + (event.type === "telemetry_dropped" ? (event.dropped ?? 0) : 0), 0);
  expect(holes).toBe(counted);
}

export const statsEvent = (windowMs = 10_000) => ({ type: "call_stats", stats: { window_ms: windowMs, connection_type: "udp" } }) as const;
