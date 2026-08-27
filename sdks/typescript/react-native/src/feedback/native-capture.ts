import type { FeedbackScreenshotCapture, FeedbackScreenshotUnavailable } from "@q9labsai/chalk-client";
import { Platform, type View } from "react-native";
import { captureRef } from "react-native-view-shot";

export type FeedbackCaptureTarget = React.RefObject<View | null>;

export type FeedbackCaptureSize = Readonly<{
  width: number;
  height: number;
}>;

const MAX_SCREENSHOT_BYTES = 450 * 1024;
const MAX_SCREENSHOT_WIDTH = 1_920;
const MAX_SCREENSHOT_HEIGHT = 1_080;

export async function captureNativeFeedbackView(target: FeedbackCaptureTarget, size: FeedbackCaptureSize): Promise<FeedbackScreenshotCapture | FeedbackScreenshotUnavailable> {
  if (Platform.OS === "macos") return { state: "unavailable", failure_code: "unsupported" };
  if (!target.current) return { state: "unavailable", failure_code: "capture_failed" };

  const outputSize = boundedOutputSize(size);
  if (!outputSize) return { state: "unavailable", failure_code: "capture_failed" };
  try {
    const captured = await captureRef(target, {
      format: "jpg",
      quality: 0.72,
      result: "base64",
      ...outputSize,
    });
    const dataBase64 = normalizeBase64(captured);
    if (!dataBase64) return { state: "unavailable", failure_code: "capture_failed" };
    if (base64ByteLength(dataBase64) > MAX_SCREENSHOT_BYTES) return { state: "unavailable", failure_code: "too_large" };

    return {
      state: "captured",
      mime_type: "image/jpeg",
      width: outputSize.width,
      height: outputSize.height,
      captured_at: new Date().toISOString(),
      data_base64: dataBase64,
    };
  } catch {
    return { state: "unavailable", failure_code: "capture_failed" };
  }
}

function boundedOutputSize(size: FeedbackCaptureSize): Readonly<{ width: number; height: number }> | undefined {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return undefined;
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / size.width, MAX_SCREENSHOT_HEIGHT / size.height);
  return {
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale)),
  };
}

function normalizeBase64(value: string): string {
  return value.replace(/^data:[^;]+;base64,/u, "").replaceAll(/\s/gu, "");
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}
