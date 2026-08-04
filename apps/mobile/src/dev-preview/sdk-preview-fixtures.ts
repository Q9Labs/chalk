import type { PreviewSearch } from "./preview-state";

export const PREVIEW_SPACE_NAME = "Design review Space";
export const PREVIEW_DISPLAY_NAME = "Hasan";

export const PREVIEW_CHAT_LINES = [
  { id: "chat-1", displayName: "Nora Williams", text: "The new Space direction feels much calmer." },
  { id: "chat-2", displayName: PREVIEW_DISPLAY_NAME, text: "Agreed. Let’s keep the controls out of the stage." },
  { id: "chat-3", displayName: "Sofia Chen", text: "I’ll share the revised agenda here after the Space." },
] as const;

export const PREVIEW_ADMISSION_REQUESTS = [
  { id: "admission-1", displayName: "Priya Shah" },
  { id: "admission-2", displayName: "Eli Morgan" },
] as const;

export function stateLabel(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function spaceStateCopy(state: PreviewSearch["state"]): string {
  switch (state) {
    case "empty":
      return "This Space has no other Participants yet.";
    case "warning":
      return "Some Space actions are temporarily unavailable.";
    case "reconnecting":
      return "The Space connection was interrupted. Reconnecting now…";
    case "retry":
      return "The Space connection needs another try.";
    case "confirmation":
      return "Are you sure you want to leave this Space?";
    case "timeout":
      return "The Space took too long to reconnect.";
    case "failure":
      return "The Space connection failed before recovery completed.";
    case "ended":
      return "This Episode has ended.";
    default:
      return "The Space is ready for collaboration.";
  }
}

export function chatCountFor(search: PreviewSearch): number {
  if (search.chat === "empty" || search.chat === "loading" || search.chat === "failure") return 0;
  return PREVIEW_CHAT_LINES.length;
}

export function productionPalette(palette: PreviewSearch["palette"]): "light" | "warm-charcoal" | "cool-graphite" | "oled-signal" {
  switch (palette) {
    case "midnight":
      return "oled-signal";
    case "slate":
      return "cool-graphite";
    case "paper":
      return "light";
    default:
      return "warm-charcoal";
  }
}

export function productionTexture(texture: PreviewSearch["texture"]): "none" | "paper" | "slate" {
  switch (texture) {
    case "soft-dots":
      return "slate";
    case "none":
      return "none";
    default:
      return "paper";
  }
}
