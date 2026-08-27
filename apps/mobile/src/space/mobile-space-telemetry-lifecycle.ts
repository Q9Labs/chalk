import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";

export type MobileSpaceJourneyEnd = "error" | "episode_ended" | "left" | "unmounted";
export type MobileSpaceLifecycleEvent = "create" | "arrive" | "pending" | "refresh" | "leave";

export function recordMobileSpaceJoined(journey: TelemetryJourney | undefined): void {
  journey?.phase("media");
}

export function recordMobileSpaceLifecycle(journey: TelemetryJourney | undefined, event: MobileSpaceLifecycleEvent, state: "failed" | "observed" | "succeeded" = "observed"): void {
  journey?.recordDiagnostic({ category: event === "refresh" ? "recovery" : "network", code: `public_invite.${event}`, phase: event === "leave" ? "terminal" : "signaling", state });
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
