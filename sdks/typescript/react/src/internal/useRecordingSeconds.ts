import { useState } from "react";

type RecordingStatus = "starting" | "recording" | "stopping" | "stopped" | "failed";

/**
 * Seconds since the recording started, counted on the Episode clock. The recording carries no start time, so only someone
 * who saw it go from starting to recording knows it; someone who joined mid-recording gets null.
 */
export function useRecordingSeconds(status: RecordingStatus | undefined, episodeSeconds: number): number | null {
  const [previous, setPrevious] = useState(status);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  if (status !== previous) {
    setPrevious(status);
    if (status === "recording" && previous === "starting") setStartedAt(episodeSeconds);
    else if (status !== "recording" && status !== "stopping") setStartedAt(null);
  }
  if (startedAt === null || (status !== "recording" && status !== "stopping")) return null;
  return Math.max(0, episodeSeconds - startedAt);
}
