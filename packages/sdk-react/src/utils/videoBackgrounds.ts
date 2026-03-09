import type { VideoBackgroundEffect } from "@q9labs/chalk-core";

export const VIDEO_BACKGROUND_PRESETS = [
  {
    id: "preset-classroom",
    name: "Classroom",
    imageUrl: "https://rtk-assets.realtime.cloudflare.com/backgrounds/bg_1.jpg",
  },
  {
    id: "preset-study",
    name: "Study",
    imageUrl: "https://rtk-assets.realtime.cloudflare.com/backgrounds/bg_2.jpg",
  },
  {
    id: "preset-library",
    name: "Library",
    imageUrl: "https://rtk-assets.realtime.cloudflare.com/backgrounds/bg_3.jpg",
  },
  {
    id: "preset-office",
    name: "Office",
    imageUrl: "https://rtk-assets.realtime.cloudflare.com/backgrounds/bg_4.jpg",
  },
] as const;

export const VIDEO_BACKGROUND_BLUR_ID = "blur";
export const VIDEO_BACKGROUND_CUSTOM_ID = "custom";

export type VideoBackgroundPresetId = (typeof VIDEO_BACKGROUND_PRESETS)[number]["id"];

export type StoredVideoBackgroundEffect = { type: "none" } | { type: "blur"; blurStrength?: number } | { type: "preset"; presetId: VideoBackgroundPresetId } | { type: "custom"; assetKey: string; fileName?: string };

export const DEFAULT_STORED_VIDEO_BACKGROUND_EFFECT: StoredVideoBackgroundEffect = {
  type: "none",
};

export const getStoredVideoBackgroundEffectId = (effect: StoredVideoBackgroundEffect | undefined): string => {
  if (!effect || effect.type === "none") {
    return "none";
  }

  if (effect.type === "blur") {
    return VIDEO_BACKGROUND_BLUR_ID;
  }

  if (effect.type === "preset") {
    return effect.presetId;
  }

  return VIDEO_BACKGROUND_CUSTOM_ID;
};

export const getVideoBackgroundPreset = (presetId: string) => VIDEO_BACKGROUND_PRESETS.find((preset) => preset.id === presetId);

export const toRuntimeVideoBackgroundEffect = (effect: StoredVideoBackgroundEffect | undefined, customImageUrl?: string | null): VideoBackgroundEffect => {
  if (!effect || effect.type === "none") {
    return { mode: "none" };
  }

  if (effect.type === "blur") {
    return {
      mode: "blur",
      blurStrength: effect.blurStrength,
    };
  }

  if (effect.type === "preset") {
    return {
      mode: "image",
      imageUrl: getVideoBackgroundPreset(effect.presetId)?.imageUrl ?? "",
    };
  }

  return customImageUrl
    ? {
        mode: "image",
        imageUrl: customImageUrl,
      }
    : { mode: "none" };
};

export const areVideoBackgroundEffectsEqual = (left: VideoBackgroundEffect | undefined, right: VideoBackgroundEffect | undefined) => {
  if (!left || !right) {
    return left === right;
  }

  if (left.mode !== right.mode) {
    return false;
  }

  if (left.mode === "blur" && right.mode === "blur") {
    return (left.blurStrength ?? 50) === (right.blurStrength ?? 50);
  }

  if (left.mode === "image" && right.mode === "image") {
    return left.imageUrl === right.imageUrl;
  }

  return true;
};
