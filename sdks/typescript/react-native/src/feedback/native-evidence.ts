import type { FeedbackEvidenceInput, FeedbackPlatformKind } from "@q9labsai/chalk-client";
import { Platform } from "react-native";

import { getDeviceInfo } from "../runtime";

export function createNativeFeedbackEvidence(): FeedbackEvidenceInput {
  const device = getDeviceInfo({ scriptUrl: null });
  const kind = feedbackPlatformKind(Platform.OS);
  const osName = boundedString(device.systemName ?? device.platform ?? kind);
  const osVersion = boundedString(device.osVersion);
  const deviceModel = boundedString(device.model);
  const reactNativeVersion = boundedString(device.reactNativeVersion);
  const deviceClass = kind === "macos" ? "desktop" : device.interfaceIdiom === "pad" ? "tablet" : "phone";

  return {
    sdk: { client: "@q9labsai/chalk-client", ...(reactNativeVersion ? { react_native: reactNativeVersion } : {}) },
    platform: {
      kind,
      ...(osName ? { os_name: osName } : {}),
      ...(osVersion ? { os_version: osVersion } : {}),
      device_class: deviceClass,
      ...(deviceModel ? { device_model: deviceModel } : {}),
    },
  };
}

function feedbackPlatformKind(platform: string): FeedbackPlatformKind {
  if (platform === "ios") return "ios";
  if (platform === "macos") return "macos";
  return "android";
}

function boundedString(value: string | null): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 64);
}
