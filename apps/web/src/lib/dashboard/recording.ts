import type { RecordingDTO, TranscriptDTO } from "./contracts";

export function pendingRecording(recording: RecordingDTO): boolean {
  // A rendered export is playable only once the recording is marked completed, so the page waits for that too.
  return recording.sourceStatus === "pending" || recording.exportStatus === "pending" || recording.transcriptionStatus === "pending" || (recording.exportStatus === "ready" && recording.status !== "completed");
}

/** The server closes the source retention window at read time, so the page closes it on its own clock too. */
export function pastSourceDeadline(recording: RecordingDTO, now: number): boolean {
  return recording.sourceExpiresAt !== null && Date.parse(recording.sourceExpiresAt) <= now;
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
  if (recording.exportStatus === "ready") {
    if (recording.status !== "completed") return "preparing";
    // A rendered export expires with its source; a legacy export the server still calls ready keeps playing.
    return recording.sourceStatus !== "expired" && pastSourceDeadline(recording, now) ? "expired" : "play";
  }
  if (recording.sourceStatus === "failed") return "capture_failed";
  if (recording.sourceStatus === "pending") return "capturing";
  if (recording.sourceStatus === "expired" || pastSourceDeadline(recording, now) || recording.exportStatus === "unavailable") return "expired";
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
  expired: { copy: "No transcript is available because the recording source could not be kept.", action: null },
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
  // "ready" already means a live transcription source; it never outlives the video deadline, which closes both.
  if (recording.transcriptionStatus === "ready") return pastSourceDeadline(recording, now) ? "expired" : "creatable";
  if (recording.transcriptionStatus === "pending") return "preparing";
  if (recording.transcriptionStatus === "failed") return "failed";
  if (recording.transcriptionStatus === "expired") return "expired";
  return "none";
}
