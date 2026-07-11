import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";

export type MobileMeetingJourneyEnd = "error" | "meeting_closed" | "meeting_ended" | "unmounted";

export function recordMobileMeetingJoined(journey: TelemetryJourney | undefined): void {
  journey?.phase("media");
}

export function terminalizeMobileMeetingJourney(journey: TelemetryJourney | undefined, end: MobileMeetingJourneyEnd): void {
  if (!journey) {
    return;
  }

  switch (end) {
    case "meeting_ended":
      journey.terminal("succeeded", { result: "meeting_ended" });
      return;
    case "error":
      journey.terminal("failed", { code: "join_error" });
      return;
    case "meeting_closed":
      journey.terminal("cancelled", { reason: "meeting_closed" });
      return;
    case "unmounted":
      journey.terminal("cancelled", { reason: "meeting_screen_unmounted" });
  }
}
