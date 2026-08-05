import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";

export type MobileSpaceJourneyEnd = "error" | "episode_ended" | "left" | "unmounted";

export function recordMobileSpaceJoined(journey: TelemetryJourney | undefined): void {
  journey?.phase("media");
}

export function terminalizeMobileSpaceJourney(journey: TelemetryJourney | undefined, end: MobileSpaceJourneyEnd): void {
  if (!journey) return;

  switch (end) {
    case "episode_ended":
      journey.terminal("succeeded", { result: "episode_ended" });
      return;
    case "error":
      journey.terminal("failed", { code: "access.unavailable" });
      return;
    case "left":
      journey.terminal("cancelled", { reason: "space_left" });
      return;
    case "unmounted":
      journey.terminal("cancelled", { reason: "space_view_unmounted" });
  }
}
