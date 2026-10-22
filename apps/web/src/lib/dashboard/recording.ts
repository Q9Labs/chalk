import type { RecordingDTO } from "./contracts";

export function pendingRecording(recording: RecordingDTO): boolean {
  return recording.sourceStatus === "pending" || recording.exportStatus === "pending" || recording.transcriptionStatus === "pending";
}
