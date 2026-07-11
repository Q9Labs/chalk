import { describe, expect, it, vi } from "vitest";
import { createNativeTelemetry, type NativeRtcPeerConnection, type NativeTelemetryJourney } from "./telemetry";

describe("createNativeTelemetry", () => {
  it("propagates one journey through API and sync transport configuration", () => {
    const journey = createJourney();
    const telemetry = createNativeTelemetry(journey);

    expect(telemetry.session).toEqual({
      apiHeaders: journey.headers,
      context: journey.context,
      syncCorrelation: {
        journey_id: journey.context.journeyId,
        traceparent: journey.context.traceparent,
        tracestate: journey.context.tracestate,
      },
    });

    telemetry.recordSyncFrame({ direction: "client_to_server", frameType: "room.join" });
    expect(journey.recordSyncFrame).toHaveBeenCalledWith({ direction: "client_to_server", frameType: "room.join" });
  });

  it("records aggregate RTC summaries from native peer-connection stats", async () => {
    const journey = createJourney();
    const telemetry = createNativeTelemetry(journey);
    const peerConnection = createPeerConnection();
    const stop = telemetry.observePeerConnection(peerConnection);

    peerConnection.connectionState = "connected";
    peerConnection.emit("connectionstatechange");

    await vi.waitFor(() => expect(journey.recordRtcSummary).toHaveBeenCalled());
    expect(journey.recordRtcSummary).toHaveBeenLastCalledWith({ connectionState: "connected", iceConnectionState: "completed", signalingState: "stable" }, [
      { type: "inbound-rtp", bytesReceived: 1200, packetsLost: 2 },
      { type: "candidate-pair", roundTripTime: 0.03 },
    ]);

    stop();
    peerConnection.emit("iceconnectionstatechange");
    expect(journey.recordRtcSummary).toHaveBeenCalledTimes(2);
  });
});

function createJourney(): NativeTelemetryJourney & {
  recordRtcSummary: ReturnType<typeof vi.fn>;
  recordSyncFrame: ReturnType<typeof vi.fn>;
} {
  return {
    context: {
      journeyId: "00000000-0000-4000-8000-000000000001",
      rootJourneyId: "00000000-0000-4000-8000-000000000001",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "chalk=mobile",
    },
    headers: {
      "x-chalk-journey-id": "00000000-0000-4000-8000-000000000001",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    },
    recordRtcSummary: vi.fn(),
    recordSyncFrame: vi.fn(),
  };
}

function createPeerConnection(): NativeRtcPeerConnection & { emit(event: "connectionstatechange" | "iceconnectionstatechange" | "signalingstatechange"): void; connectionState: string } {
  const listeners = new Map<string, Set<() => void>>();

  return {
    connectionState: "connecting",
    iceConnectionState: "completed",
    signalingState: "stable",
    addEventListener(event, listener) {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    },
    removeEventListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    async getStats() {
      return new Map([
        ["inbound", { type: "inbound-rtp", bytesReceived: 1200, packetsLost: 2 }],
        ["pair", { type: "candidate-pair", roundTripTime: 0.03 }],
      ]);
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}
