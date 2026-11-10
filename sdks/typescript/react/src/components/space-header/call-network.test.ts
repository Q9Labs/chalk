import type { CallStatsSample } from "@q9labsai/chalk-client";
import { expect, it } from "vitest";
import { callCharts, callNetwork, connectionQuality } from "./call-network";

const sample = (fields: Partial<CallStatsSample> = {}): CallStatsSample => ({ elapsed_ms: 10_000, window_ms: 10_000, connection_type: "udp", ...fields });

it("maps call stats windows to chart series with headline values from the newest window", () => {
  const charts = callCharts([sample({ rtt_ms: 44, send_loss_pct: 0, recv_loss_pct: 0.4, send_bitrate_kbps: 1100, recv_bitrate_kbps: 3100 }), sample({ rtt_ms: 42, send_loss_pct: 0.1, recv_loss_pct: 0, send_bitrate_kbps: 1240, recv_bitrate_kbps: 3400 })]);
  expect(charts?.latency).toEqual({ points: [44, 42], headline: "42" });
  expect(charts?.loss).toEqual({ points: [0.4, 0.1], headline: "0.1" });
  expect(charts?.bandwidth).toEqual({ upload: [1.1, 1.24], download: [3.1, 3.4], headline: "1.2 / 3.4" });
});

it("keeps a gap for a window that measured nothing instead of drawing zero", () => {
  const charts = callCharts([sample({ rtt_ms: 40 }), sample({}), sample({ rtt_ms: 41 })]);
  expect(charts?.latency.points).toEqual([40, null, 41]);
  expect(charts?.loss.points).toEqual([null, null, null]);
  expect(charts?.loss.headline).toBe("–");
});

it("waits for a second window before offering charts", () => {
  expect(callCharts([])).toBeNull();
  expect(callCharts([sample({ rtt_ms: 40 })])).toBeNull();
});

it("rates the connection from the newest window and says why when it is weak", () => {
  expect(connectionQuality(true, [])).toMatchObject({ level: 4, tone: "good", word: "Connected" });
  expect(connectionQuality(true, [sample({ rtt_ms: 60, recv_loss_pct: 0.2 })])).toMatchObject({ level: 4, word: "Excellent" });
  expect(connectionQuality(true, [sample({ rtt_ms: 250 })])).toMatchObject({ level: 3, tone: "warn", word: "Fair" });
  expect(connectionQuality(true, [sample({ rtt_ms: 40, recv_loss_pct: 8 })])).toMatchObject({ level: 2, word: "Unstable", helper: "8% of packets are getting lost. Audio may break up." });
  expect(connectionQuality(true, [sample({ rtt_ms: 900 })])).toMatchObject({ level: 2, word: "Unstable" });
  expect(connectionQuality(true, [sample({ rtt_ms: 900 }), sample({ rtt_ms: 40 })]).word).toBe("Excellent");
});

it("reports reconnecting regardless of old stats", () => {
  expect(callNetwork(false, [sample({ rtt_ms: 40 }), sample({ rtt_ms: 41 })]).quality).toMatchObject({ level: 1, tone: "bad", word: "Reconnecting…" });
});
