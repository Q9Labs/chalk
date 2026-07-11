import { createTelemetryClient } from "@q9labsai/chalk-client/telemetry";
import { describe, expect, it } from "vitest";
import { recordMobileMeetingJoined, terminalizeMobileMeetingJourney } from "./mobile-meeting-telemetry-lifecycle";

describe("mobile meeting telemetry lifecycle", () => {
  it("keeps a joined meeting journey open for sync, RTC, and diagnostic telemetry until the meeting ends", () => {
    const telemetry = createTelemetryClient({ enabled: true });
    const journey = telemetry.startJourney({ kind: "meeting.join" });

    recordMobileMeetingJoined(journey);
    journey.recordSyncFrame({ direction: "server_to_client", frameType: "transport.connected" });
    journey.recordRtcSummary({ connectionState: "connected", iceConnectionState: "completed", signalingState: "stable" }, []);
    journey.recordDiagnostic({ category: "session", code: "meeting_active" });
    terminalizeMobileMeetingJourney(journey, "meeting_ended");

    expect(telemetry.getPendingEvents()).toMatchObject([
      { name: "journey.started", state: "started" },
      { name: "journey.phase", phase: "media", state: "in_progress" },
      { name: "sync.frame", state: "observed" },
      { name: "rtc.summary", state: "observed" },
      { name: "diagnostic.timeline", state: "observed" },
      { name: "journey.terminal", state: "succeeded", attributes: { result: "meeting_ended" } },
    ]);
    const terminalEventCount = telemetry.getPendingEvents().length;
    expect(journey.recordSyncFrame({ direction: "client_to_server", frameType: "room.leave" })).toBeUndefined();
    expect(telemetry.getPendingEvents()).toHaveLength(terminalEventCount);
  });

  it.each([
    ["error", "failed", { code: "join_error" }],
    ["meeting_closed", "cancelled", { reason: "meeting_closed" }],
    ["unmounted", "cancelled", { reason: "meeting_screen_unmounted" }],
  ] as const)("records %s as a %s terminal outcome", (end, state, attributes) => {
    const telemetry = createTelemetryClient({ enabled: true });
    const journey = telemetry.startJourney({ kind: "meeting.join" });

    terminalizeMobileMeetingJourney(journey, end);

    expect(telemetry.getPendingEvents().at(-1)).toMatchObject({ name: "journey.terminal", state, attributes });
  });
});
