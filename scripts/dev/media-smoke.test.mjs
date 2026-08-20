import { describe, expect, it } from "vitest";

import { aggregateRtcStats, assertPositiveRtcDeltas, createFailureRecorder, deltaRtcStats, normalizeReadyRuntimeManifest, preserveFirstFailure, redactProof, runMediaProof } from "./media-smoke.mjs";

const readyManifest = {
  status: "ready",
  runtime_id: "runtime-test",
  web: { url: "http://127.0.0.1:3070" },
  web_join_path: "/space",
  observability: { proofEndpoint: "http://127.0.0.1:8080/local-proof" },
};

function expectErrorCode(action, code) {
  try {
    action();
    throw new Error("expected action to throw");
  } catch (error) {
    expect(error.code).toBe(code);
  }
}

describe("media smoke RTC proof", () => {
  it("aggregates inbound and outbound audio/video counters by kind", () => {
    expect(
      aggregateRtcStats([
        { type: "inbound-rtp", kind: "audio", bytesReceived: 100, packetsReceived: 10 },
        { type: "inbound-rtp", mediaType: "audio", bytesReceived: 25, packetsReceived: 2 },
        { type: "inbound-rtp", kind: "video", bytesReceived: 500, packetsReceived: 50 },
        { type: "outbound-rtp", kind: "audio", bytesSent: 90, packetsSent: 9 },
        { type: "outbound-rtp", kind: "video", bytesSent: 700, packetsSent: 70 },
        { type: "candidate-pair", roundTripTime: 0.01 },
      ]),
    ).toEqual({
      inbound: {
        audio: { bytes: 125, packets: 12, streams: 2 },
        video: { bytes: 500, packets: 50, streams: 1 },
      },
      outbound: {
        audio: { bytes: 90, packets: 9, streams: 1 },
        video: { bytes: 700, packets: 70, streams: 1 },
      },
    });
  });

  it("requires positive bytes and packet deltas for all directions and kinds", () => {
    const before = aggregateRtcStats([
      { type: "inbound-rtp", kind: "audio", bytesReceived: 10, packetsReceived: 1 },
      { type: "inbound-rtp", kind: "video", bytesReceived: 20, packetsReceived: 2 },
      { type: "outbound-rtp", kind: "audio", bytesSent: 30, packetsSent: 3 },
      { type: "outbound-rtp", kind: "video", bytesSent: 40, packetsSent: 4 },
    ]);
    const after = aggregateRtcStats([
      { type: "inbound-rtp", kind: "audio", bytesReceived: 11, packetsReceived: 2 },
      { type: "inbound-rtp", kind: "video", bytesReceived: 21, packetsReceived: 3 },
      { type: "outbound-rtp", kind: "audio", bytesSent: 31, packetsSent: 4 },
      { type: "outbound-rtp", kind: "video", bytesSent: 41, packetsSent: 5 },
    ]);
    expect(assertPositiveRtcDeltas(deltaRtcStats(before, after))).toBe(true);
    expect(() => assertPositiveRtcDeltas(deltaRtcStats(before, before))).toThrow("inbound audio RTP counters did not increase");
  });
});

describe("media smoke redaction and failure ordering", () => {
  it("redacts secrets and sensitive payloads without losing proof counters", () => {
    const redacted = redactProof({
      apiKey: "chalk_sk_live_secret",
      inviteToken: "invite-capability",
      authorization: "Bearer eyJheader.payload.signature",
      endpoint: "http://127.0.0.1:8080/proof?token=secret-value",
      fragment: "http://127.0.0.1:8080/proof#invite=fragment-secret",
      stats: { inbound: { audio: { bytes: 123, packets: 4 } } },
    });
    expect(JSON.stringify(redacted)).not.toContain("chalk_sk_live_secret");
    expect(JSON.stringify(redacted)).not.toContain("invite-capability");
    expect(JSON.stringify(redacted)).not.toContain("secret-value");
    expect(JSON.stringify(redacted)).not.toContain("fragment-secret");
    expect(redacted.stats.inbound.audio).toEqual({ bytes: 123, packets: 4 });
  });

  it("keeps the first failure when later cleanup fails", () => {
    const first = { phase: "media", code: "rtc_stats_not_increasing" };
    const later = { phase: "cleanup", code: "cleanup_leave_ui_missing" };
    expect(preserveFirstFailure(undefined, first)).toBe(first);
    expect(preserveFirstFailure(first, later)).toBe(first);
    const recorder = createFailureRecorder();
    recorder.record(first);
    recorder.record(later);
    expect(recorder.firstFailure).toBe(first);
  });
});

describe("media smoke runtime manifest gate", () => {
  it("normalizes a ready localhost manifest", () => {
    expect(normalizeReadyRuntimeManifest(readyManifest)).toMatchObject({
      runtimeID: "runtime-test",
      status: "ready",
      webOrigin: "http://127.0.0.1:3070",
      webJoinPath: "/space",
      observabilityProofURL: "http://127.0.0.1:8080/local-proof",
    });
  });

  it.each([
    ["reloading", "manifest_not_ready"],
    ["degraded", "manifest_not_ready"],
  ])("rejects a %s runtime before browser launch", (status, code) => {
    expectErrorCode(() => normalizeReadyRuntimeManifest({ ...readyManifest, status }), code);
  });

  it("rejects a ready manifest with a non-local web endpoint", () => {
    expectErrorCode(() => normalizeReadyRuntimeManifest({ ...readyManifest, web: { url: "https://chalkmeet.com" } }), "manifest_non_local_url");
  });

  it("rejects a ready manifest without an observability proof endpoint", () => {
    const { observability: _observability, ...withoutProof } = readyManifest;
    expectErrorCode(() => normalizeReadyRuntimeManifest(withoutProof), "manifest_missing_observability_proof");
  });

  it("rejects a ready manifest without a derived web join path", () => {
    const { web_join_path: _webJoinPath, ...withoutJoinPath } = readyManifest;
    expectErrorCode(() => normalizeReadyRuntimeManifest(withoutJoinPath), "manifest_missing_web_join_path");
  });

  it("accepts a supplied observability proof callback without a URL", () => {
    const { observability: _observability, ...withoutProof } = readyManifest;
    expect(normalizeReadyRuntimeManifest(withoutProof, { observabilityProof: async () => ({ status: "succeeded" }) })).toMatchObject({ runtimeID: "runtime-test", observabilityProofURL: undefined });
  });

  it("returns the manifest failure before launching a browser", async () => {
    let launched = false;
    const report = await runMediaProof(
      { ...readyManifest, status: "reload-failed" },
      {
        writeProof: false,
        browserType: {
          launch: async () => {
            launched = true;
          },
        },
      },
    );
    expect(launched).toBe(false);
    expect(report.result).toBe("failed");
    expect(report.firstFailure).toMatchObject({ phase: "manifest", code: "manifest_not_ready" });
    expect(report.cleanup.status).toBe("passed");
  });
});
