import type { MediaDevice } from "@q9labsai/chalk-client";

export type PreviewMediaDevices = Readonly<{
  readonly microphones: readonly MediaDevice[];
  readonly cameras: readonly MediaDevice[];
  readonly speakers: readonly MediaDevice[];
}>;

/** One immutable fixture set shared by the preview client and web media adapter. */
export const PREVIEW_DEVICE_FIXTURES: PreviewMediaDevices = Object.freeze({
  microphones: Object.freeze([Object.freeze({ deviceId: "preview-microphone", label: "Preview microphone" }), Object.freeze({ deviceId: "preview-microphone-backup", label: "Preview microphone · backup" })]),
  cameras: Object.freeze([Object.freeze({ deviceId: "preview-camera", label: "Preview camera" }), Object.freeze({ deviceId: "preview-camera-wide", label: "Preview camera · wide" })]),
  speakers: Object.freeze([Object.freeze({ deviceId: "preview-speaker", label: "Preview speaker" }), Object.freeze({ deviceId: "preview-speaker-headphones", label: "Preview speaker · headphones" })]),
});

export function createPreviewMediaDevices(): PreviewMediaDevices {
  return {
    microphones: PREVIEW_DEVICE_FIXTURES.microphones.map((device) => ({ ...device })),
    cameras: PREVIEW_DEVICE_FIXTURES.cameras.map((device) => ({ ...device })),
    speakers: PREVIEW_DEVICE_FIXTURES.speakers.map((device) => ({ ...device })),
  };
}
