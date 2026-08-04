import { createTelemetryClient } from "@q9labsai/chalk-client/telemetry";
import { describe, expect, it } from "vitest";

import { recordMobileSpaceJoined, terminalizeMobileSpaceJourney } from "./mobile-space-telemetry-lifecycle";

describe("mobile Space telemetry lifecycle", () => {
  it("keeps a joined Space journey open for sync, RTC, and diagnostic telemetry until the Episode ends", () => {
    const telemetry = createTelemetryClient({ enabled: true });
    const journey = telemetry.startJourney({ kind: "space.join" });

    recordMobileSpaceJoined(journey);
    journey.recordSyncFrame({ direction: "server_to_client", frameType: "transport.connected" });
    journey.recordRtcSummary({ connectionState: "connected", iceConnectionState: "completed", signalingState: "stable" }, []);
    journey.recordDiagnostic({ category: "connection", code: "space.live" });
    terminalizeMobileSpaceJourney(journey, "episode_ended");

    expect(telemetry.getPendingEvents()).toMatchObject([
      { name: "journey.started", state: "started" },
      { name: "journey.phase", phase: "media", state: "in_progress" },
      { name: "sync.frame", state: "observed" },
      { name: "rtc.summary", state: "observed" },
      { name: "diagnostic.timeline", state: "observed" },
      { name: "journey.terminal", state: "succeeded", attributes: { result: "episode_ended" } },
    ]);
    const terminalEventCount = telemetry.getPendingEvents().length;
    expect(journey.recordSyncFrame({ direction: "client_to_server", frameType: "space.leave" })).toBeUndefined();
    expect(telemetry.getPendingEvents()).toHaveLength(terminalEventCount);
  });

  it.each([
    ["error", "failed", { code: "access.unavailable" }],
    ["left", "cancelled", { reason: "space_left" }],
    ["unmounted", "cancelled", { reason: "space_view_unmounted" }],
  ] as const)("records %s as a %s terminal outcome", (end, state, attributes) => {
    const telemetry = createTelemetryClient({ enabled: true });
    const journey = telemetry.startJourney({ kind: "space.join" });

    terminalizeMobileSpaceJourney(journey, end);

    expect(telemetry.getPendingEvents().at(-1)).toMatchObject({ name: "journey.terminal", state, attributes });
  });
});
