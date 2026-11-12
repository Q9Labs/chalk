import { videoGroup, type VideoGroup, type VideoState } from "./recording";

/** A past session as its row on the call page shows it. */
export type RowModel = {
  readonly spaceId: string;
  readonly episodeId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly people: number;
  readonly video: VideoState | null;
  readonly transcript: "ready" | "processing" | "none" | "unavailable";
};

export type Tone = "ok" | "acc" | "bad" | "mu" | "plain";
export type Badge = { readonly label: string; readonly tone: Tone; readonly icon?: "check" | "spin" | "dot" };

/** The video as a pill: the same words on the call page and the session page. */
export const VIDEO_BADGE: Record<VideoGroup, Badge> = {
  ready: { label: "Ready", tone: "ok", icon: "check" },
  processing: { label: "Processing", tone: "acc", icon: "spin" },
  prepare: { label: "Not prepared", tone: "plain" },
  failed: { label: "Failed", tone: "bad", icon: "dot" },
  expired: { label: "Expired", tone: "mu" },
};

/** A session row calls a ready video "Recording", since the column is about what the session kept. */
export function recordingBadge(video: VideoState | null): Badge {
  if (video === null) return { label: "No recording", tone: "mu" };
  const group = videoGroup(video);
  return group === "ready" ? { label: "Recording", tone: "plain", icon: "check" } : VIDEO_BADGE[group];
}

export function transcriptBadge(transcript: RowModel["transcript"], video: VideoState | null): Badge {
  if (transcript === "ready") return { label: "Transcript", tone: "plain", icon: "check" };
  if (transcript === "processing") return { label: "Processing", tone: "acc", icon: "spin" };
  if (transcript === "unavailable") return { label: "Unavailable", tone: "mu" };
  const group = video === null ? null : videoGroup(video);
  return group === "ready" || group === "processing" || group === "prepare" ? { label: "None yet", tone: "mu" } : { label: "–", tone: "mu" };
}
