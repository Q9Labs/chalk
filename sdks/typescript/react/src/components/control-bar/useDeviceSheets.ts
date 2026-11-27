import { useState } from "react";
import type { ControlBarMicrophonePicker } from "./control-bar-props";

export function useDeviceSheets(microphonePicker: ControlBarMicrophonePicker | undefined) {
  const [sheet, setSheet] = useState<"mic" | "video" | null>(null);
  return {
    microphoneOpen: microphonePicker?.open ?? sheet === "mic",
    setMicrophoneOpen: microphonePicker?.onOpenChange ?? ((open: boolean) => setSheet(open ? "mic" : null)),
    cameraOpen: sheet === "video",
    setCameraOpen: (open: boolean) => setSheet(open ? "video" : null),
  };
}
