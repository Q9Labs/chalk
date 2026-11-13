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
  capture_failed: { title: "The recording couldn’t be made", detail: "Who joined and when is still kept below.", action: null },
  expired: { title: "The recording is no longer available", detail: "Who joined and when is still kept below.", action: null },
  capturing: { title: "Processing the recording", detail: "You can leave this page and return when the video is ready.", action: null },
  preparing: { title: "Preparing the recording", detail: "You can leave this page and return when the video is ready.", action: null },
  preparable: { title: "The recording is ready to prepare", detail: "Prepare this session’s video to watch or download it.", action: "prepare" },
  retryable: { title: "The recording couldn’t be prepared", detail: "The recording export could not be completed.", action: "retry" },
  export_failed: { title: "The recording couldn’t be prepared", detail: "Contact support and we’ll look into it.", action: null },
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

/** The words a list uses for a video: Recordings filters by these, and rows draw one pill for each. */
export type VideoGroup = "ready" | "processing" | "prepare" | "failed" | "expired";

const GROUP: Record<VideoState, VideoGroup> = { play: "ready", capturing: "processing", preparing: "processing", preparable: "prepare", capture_failed: "failed", retryable: "failed", export_failed: "failed", expired: "expired" };

export const videoGroup = (state: VideoState): VideoGroup => GROUP[state];

/** What a session kept: its newest completed recording, else its newest recording. Recordings arrive newest first. */
export function keptRecording<T extends { readonly status: string }>(recordings: readonly T[]): T | undefined {
  return recordings.find((item) => item.status === "completed") ?? recordings[0];
}

export type TranscriptState = "ready" | "preparing" | "failed" | "deleted" | "expired" | "creatable" | "none";

/** What the transcript panel says when there is no transcript to read, and whether it may offer to make one. */
export const TRANSCRIPT: Record<TranscriptState, { readonly title: string; readonly detail: string; readonly action: "download" | "create" | null }> = {
  ready: { title: "", detail: "", action: "download" },
  preparing: { title: "Making the transcript", detail: "It shows here when it’s ready. You can leave this page.", action: null },
  failed: { title: "The transcript couldn’t be made", detail: "Something went wrong while it was being made.", action: null },
  deleted: { title: "This transcript was deleted", detail: "A deleted transcript can’t be brought back.", action: null },
  expired: { title: "A transcript can’t be made now", detail: "The audio for this recording is no longer kept.", action: null },
  creatable: { title: "No transcript yet", detail: "Make one from this recording. It takes a few minutes.", action: "create" },
  none: { title: "No transcript", detail: "Transcription was off when this session was recorded.", action: null },
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
