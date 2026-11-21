import { useState } from "react";
import type { ControlBarProps } from "./control-bar-behavior";

export function useDeviceSheets(microphonePicker: ControlBarProps["microphonePicker"]) {
  const [sheet, setSheet] = useState<"mic" | "video" | null>(null);
  return {
    microphoneOpen: microphonePicker?.open ?? sheet === "mic",
    setMicrophoneOpen: microphonePicker?.onOpenChange ?? ((open: boolean) => setSheet(open ? "mic" : null)),
    cameraOpen: sheet === "video",
    setCameraOpen: (open: boolean) => setSheet(open ? "video" : null),
  };
}
