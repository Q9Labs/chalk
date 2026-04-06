import type { ParticipantState } from "@q9labs/chalk-core";

export type RoomParticipant = ParticipantState["participants"][number];
export type NativeMeetingPanelName = "chat" | "participants" | "settings" | "transcripts" | "whiteboard";
