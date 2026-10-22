import type { RecordingDTO, TranscriptDTO } from "./contracts";

/** A recording is polled exactly while the page shows it waiting, so a terminal state never polls and a wait never stalls. */
export function pendingRecording(recording: RecordingDTO, now = Date.now()): boolean {
  const video = videoState(recording, now);
  return video === "capturing" || video === "preparing" || recording.transcriptionStatus === "pending" || lapsedExport(recording, now);
}

/** Only the server knows whether a ready export outlives its source, so one past its deadline is read until the server answers. */
export function lapsedExport(recording: RecordingDTO, now: number): boolean {
  return recording.exportStatus === "ready" && recording.sourceStatus !== "expired" && passed(recording.sourceExpiresAt, now);
}

/** The server closes retention windows at read time, so the page closes them on its own clock too. */
export function passed(deadline: string | null, now: number): boolean {
  return deadline !== null && Date.parse(deadline) <= now;
}

export type VideoState = "play" | "capture_failed" | "expired" | "capturing" | "preparing" | "preparable" | "retryable" | "export_failed";
export type VideoAction = "play" | "prepare" | "retry" | null;

/** What the page says about a recording's video, and the one action the API accepts for it. */
export const VIDEO: Record<VideoState, { readonly title: string; readonly detail: string; readonly action: VideoAction }> = {
  play: { title: "", detail: "", action: "play" },
  capture_failed: { title: "The recording couldn’t be made", detail: "The recording capture did not complete.", action: null },
  expired: { title: "The recording is no longer available", detail: "The recording source is no longer available.", action: null },
  capturing: { title: "Processing the recording", detail: "You can leave this page and return when the video is ready.", action: null },
  preparing: { title: "Preparing the recording", detail: "You can leave this page and return when the video is ready.", action: null },
  preparable: { title: "The recording is ready to prepare", detail: "Prepare this session’s video to watch or download it.", action: "prepare" },
  retryable: { title: "The recording couldn’t be prepared", detail: "The recording export could not be completed.", action: "retry" },
  export_failed: { title: "The recording couldn’t be prepared", detail: "The recording export could not be completed.", action: null },
};

export function videoState(recording: RecordingDTO, now: number): VideoState {
  // A rendered export expires with its source, but a legacy one can outlive it, so the page rereads a ready export at its deadline instead of guessing.
  if (recording.exportStatus === "ready") return recording.status === "completed" ? "play" : "preparing";
  if (recording.sourceStatus === "failed") return "capture_failed";
  if (recording.sourceStatus === "pending") return "capturing";
  if (recording.sourceStatus === "expired" || passed(recording.sourceExpiresAt, now) || recording.exportStatus === "unavailable") return "expired";
  if (recording.exportStatus === "pending") return "preparing";
  if (recording.exportStatus === "failed") return recording.exportRetryable ? "retryable" : "export_failed";
  return "preparable";
}

export type TranscriptState = "ready" | "preparing" | "failed" | "deleted" | "expired" | "creatable" | "none";

/** What the transcript panel says, and whether it may offer to make a transcript. */
export const TRANSCRIPT: Record<TranscriptState, { readonly copy: string; readonly action: "download" | "create" | null }> = {
  ready: { copy: "", action: "download" },
  preparing: { copy: "The transcript is being prepared.", action: null },
  failed: { copy: "The transcript couldn’t be made", action: null },
  deleted: { copy: "This transcript was deleted.", action: null },
  expired: { copy: "A transcript can no longer be made for this recording.", action: null },
  creatable: { copy: "There’s no transcript for this recording.", action: "create" },
  none: { copy: "There’s no transcript for this recording.", action: null },
};

const IN_PROGRESS = new Set(["preparing", "transcribing", "verifying", "retryable_failure", "pending", "processing"]);

export function transcriptState(recording: RecordingDTO, transcript: TranscriptDTO | null, now: number): TranscriptState {
  if (transcript) {
    if (transcript.status === "complete" || transcript.status === "completed") return "ready";
    if (IN_PROGRESS.has(transcript.status)) return "preparing";
    if (transcript.status === "terminal_failure" || transcript.status === "failed") return "failed";
    if (transcript.status === "deleted") return "deleted";
    // Any other row, such as not_requested, still blocks a new request.
    return "none";
  }
  // The transcription source has its own deadline, never later than the video's; either one closes it.
  if (recording.transcriptionStatus === "ready") return passed(recording.transcriptionExpiresAt, now) || passed(recording.sourceExpiresAt, now) ? "expired" : "creatable";
  if (recording.transcriptionStatus === "pending") return "preparing";
  if (recording.transcriptionStatus === "failed") return "failed";
  if (recording.transcriptionStatus === "expired") return "expired";
  return "none";
}
