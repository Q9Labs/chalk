import type { RecordingDTO, TranscriptDTO } from "./contracts";

/** The server reports work in progress on this recording, so a page that shows it waiting polls until the work ends. */
export function workingRecording(recording: RecordingDTO): boolean {
  const video = videoState(recording);
  return video === "capturing" || video === "preparing" || recording.transcriptionStatus === "pending";
}

/** The recording still has a window the server could close: a source to prepare from, or a transcription source to make a transcript from. */
export function openWindow(recording: RecordingDTO): boolean {
  return recording.sourceStatus === "available" || recording.transcriptionStatus === "ready";
}

/**
 * The server closes retention windows by its own clock, so the page never closes one itself. Once a deadline has passed
 * by the server's clock (the page's clock plus the offset from the response that carried the deadline) and the server
 * still reports the window open, the recording is due for a read until the server agrees. A skewed clock then can't hide
 * an action the server accepts, and a legacy export that outlives its source keeps playing.
 */
export function lapsed(recording: RecordingDTO, serverNow: number): boolean {
  if (recording.sourceStatus === "available" && passed(recording.sourceExpiresAt, serverNow)) return true;
  return recording.transcriptionStatus === "ready" && (passed(recording.transcriptionExpiresAt, serverNow) || passed(recording.sourceExpiresAt, serverNow));
}

function passed(deadline: string | null, now: number): boolean {
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

export function videoState(recording: RecordingDTO): VideoState {
  if (recording.exportStatus === "ready") return recording.status === "completed" ? "play" : "preparing";
  if (recording.sourceStatus === "failed") return "capture_failed";
  if (recording.sourceStatus === "pending") return "capturing";
  if (recording.sourceStatus === "expired" || recording.exportStatus === "unavailable") return "expired";
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

export const completedTranscript = (transcript: TranscriptDTO) => transcript.status === "complete" || transcript.status === "completed";
export const pendingTranscript = (transcript: TranscriptDTO) => IN_PROGRESS.has(transcript.status);

export function transcriptState(recording: RecordingDTO, transcript: TranscriptDTO | null): TranscriptState {
  if (transcript) {
    if (completedTranscript(transcript)) return "ready";
    if (pendingTranscript(transcript)) return "preparing";
    if (transcript.status === "terminal_failure" || transcript.status === "failed") return "failed";
    if (transcript.status === "deleted") return "deleted";
    // Any other row, such as not_requested, still blocks a new request.
    return "none";
  }
  if (recording.transcriptionStatus === "ready") return "creatable";
  if (recording.transcriptionStatus === "pending") return "preparing";
  if (recording.transcriptionStatus === "failed") return "failed";
  if (recording.transcriptionStatus === "expired") return "expired";
  return "none";
}
