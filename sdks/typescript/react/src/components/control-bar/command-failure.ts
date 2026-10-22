import { SpaceClientError, type ClientFailure, type MediaSource } from "@q9labsai/chalk-client";

export type MediaCommandSource = MediaSource | "speaker";
export type MediaCommandAction = "start" | "stop";

export function commandFailure(cause: unknown): ClientFailure {
  return cause instanceof SpaceClientError
    ? cause
    : new SpaceClientError({
        code: "client.internal_error",
        recoverable: false,
        message: cause instanceof Error ? cause.message : "This command could not be completed.",
      });
}

/** Media failures use public guidance; source-less non-media commands retain their own guidance. */
export function commandFailureMessage(failure: ClientFailure, source?: MediaCommandSource, action?: MediaCommandAction): string {
  const device = source ?? "device";
  if (source === "speaker" && failure.code === "environment.unsupported") return "This browser can’t change your speaker. Use your system sound settings to choose an output device.";
  if (failure.code === "media.request_invalid") return "The media request is no longer active.";
  if (action === "stop" && failure.code.startsWith("media.")) return `Couldn’t ${source === "screen" ? "stop screen sharing" : `change your ${device} settings`}.${failure.recoverable ? " Try again." : ""}`;
  if (source === "screen" && failure.code === "media.permission_denied") return `Your screen couldn’t be shared. Allow screen recording for your browser in System Settings${failure.recoverable ? ", then try again" : ""}.`;
  if (failure.code === "media.permission_denied") return `Chalk can’t use your ${device}. Click the camera icon in the address bar and allow ${source === "camera" ? "Camera" : source === "microphone" ? "Microphone" : "Camera and Microphone"}.`;
  if (failure.code === "media.device_not_found") return `No ${device} found. Plug one in, or check that your Mac can see it in System Settings.`;
  if (failure.code === "media.device_busy") return `Your ${device} is being used by another app. Close it there${failure.recoverable ? ", then try again" : ""}.`;
  if (failure.code === "media.device_constraint_invalid") return `Your ${device} doesn’t support these settings. Choose another ${device}${failure.recoverable ? ", then try again" : ""}.`;
  if (failure.code === "media.capture_failed" && source === "screen") return `${action === "start" ? "Your screen couldn’t be shared." : "Couldn’t change screen sharing."}${failure.recoverable ? " Try again." : ""}`;
  if (failure.code === "media.capture_failed") return `${action === "start" ? `Your ${device} couldn’t start.` : `Couldn’t change your ${device} settings.`} Check that it is connected and available${failure.recoverable ? ", then try again" : ""}.`;
  if (source && failure.code === "connection.invalid_state") return `That change was interrupted.${failure.recoverable ? " Try again." : ""}`;
  if ((source || failure.code.startsWith("media.")) && !failure.recoverable) return `Couldn’t change ${source === "screen" ? "screen sharing" : `your ${device} settings`}.`;
  if (source || failure.code.startsWith("media.")) return `Couldn’t change ${source === "screen" ? "screen sharing" : `your ${device} settings`}. Try again.`;
  return failure.message;
}
