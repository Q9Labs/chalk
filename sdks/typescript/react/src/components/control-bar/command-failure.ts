import { SpaceClientError, type ClientFailure, type ErrorCode, type MediaSource } from "@q9labsai/chalk-client";

export type MediaCommandSource = MediaSource | "speaker";
export type MediaCommandAction = "start" | "stop" | "select" | "test" | "request";
type Operation = MediaCommandAction | "change";
type Context = { readonly source?: MediaCommandSource; readonly recoverable: boolean };
type Copy = (context: Context) => string;
type Rule = { readonly copy: Readonly<Record<Operation, Copy>>; readonly retry: boolean };

export function commandFailure(cause: unknown): ClientFailure {
  return cause instanceof SpaceClientError
    ? cause
    : new SpaceClientError({
        code: "client.internal_error",
        recoverable: false,
        message: cause instanceof Error ? cause.message : "This command could not be completed.",
      });
}

const again = ({ recoverable }: Context) => (recoverable ? " Try again." : "");
const device = ({ source }: Context) => source ?? "device";
const settings: Copy = (context) => `Couldn’t change ${context.source === "screen" ? "screen sharing" : `your ${device(context)} settings`}.`;
const stop: Copy = (context) => (context.source === "screen" ? "Couldn’t stop screen sharing." : settings(context));
const start: Copy = (context) => (context.source === "screen" ? "Your screen couldn’t be shared." : `Your ${device(context)} couldn’t start.`);
const test: Copy = () => "Couldn’t play the speaker test. Check your browser’s audio settings and system volume.";
const operationCopy = {
  start: (context) => `${start(context)}${again(context)}`,
  stop: (context) => `${stop(context)}${again(context)}`,
  select: (context) => `Couldn’t select your ${device(context)}.${again(context)}`,
  test: (context) => `${test(context)}${again(context)}`,
  request: (context) => `Couldn’t respond to the ${device(context)} request.${again(context)}`,
  change: (context) => `${settings(context)}${again(context)}`,
} satisfies Record<Operation, Copy>;
const generic: Rule = { copy: operationCopy, retry: true };
const unavailable: Rule = { copy: operationCopy, retry: false };
const specific = (copy: Copy): Rule => ({ copy: { ...operationCopy, start: copy, select: copy, request: copy, change: copy }, retry: false });
const capture: Copy = (context) => `${settings(context)} Check that it is connected and available${context.recoverable ? ", then try again" : ""}.`;
const captureStart: Copy = (context) => (context.source === "screen" ? `${start(context)}${again(context)}` : `Your ${device(context)} couldn’t start. Check that it is connected and available${context.recoverable ? ", then try again" : ""}.`);

/** Every client code has a media-context policy. Non-media commands are preserved at the boundary below. */
export const MEDIA_FAILURE_POLICY = {
  "access.invalid": specific(() => "Your call access is unavailable. Rejoin the call."),
  "access.unavailable": specific(() => "Your call access is unavailable. Rejoin the call."),
  "chat.cursor_reset_required": unavailable,
  "chat.payload_invalid": unavailable,
  "client.internal_error": generic,
  "collaboration.unavailable": unavailable,
  "command.rate_limited": generic,
  "command.rejected": unavailable,
  "connection.invalid_state": {
    copy: {
      ...operationCopy,
      start: (context) => `That change was interrupted.${again(context)}`,
      stop: (context) => `That change was interrupted.${again(context)}`,
      select: (context) => `That change was interrupted.${again(context)}`,
      change: (context) => `That change was interrupted.${again(context)}`,
    },
    retry: true,
  },
  "connection.join_cleanup_unconfirmed": unavailable,
  "connection.leave_unconfirmed": unavailable,
  "connection.media_recovery_exhausted": unavailable,
  "connection.media_start_failed": generic,
  "connection.state_digest_recovery_failed": unavailable,
  "connection.sync_recovery_exhausted": unavailable,
  "connection.sync_start_failed": unavailable,
  "connection.sync_hello_timeout": unavailable,
  "environment.unsupported": {
    copy: {
      ...operationCopy,
      start: () => "Media capture is unavailable in this environment. Use a supported browser over HTTPS or the native app.",
      request: () => "Media capture is unavailable in this environment. Use a supported browser over HTTPS or the native app.",
      select: (context) => (context.source === "speaker" ? "This browser can’t change your speaker. Use your system sound settings to choose an output device." : "Media capture is unavailable in this environment. Use a supported browser over HTTPS or the native app."),
      test: () => "This browser can’t play a speaker test. Check your browser’s audio settings or use another supported browser.",
      change: (context) => (context.source === "speaker" ? "This browser can’t change your speaker. Use your system sound settings to choose an output device." : "Media capture is unavailable in this environment. Use a supported browser over HTTPS or the native app."),
    },
    retry: false,
  },
  "episode.ended": { copy: { start: () => "This call has ended.", stop: () => "This call has ended.", select: () => "This call has ended.", test: () => "This call has ended.", request: () => "This call has ended.", change: () => "This call has ended." }, retry: false },
  "media.permission_denied": specific((context) =>
    context.source === "screen"
      ? `Your screen couldn’t be shared. Allow screen recording for your browser in System Settings${context.recoverable ? ", then try again" : ""}.`
      : context.source === "speaker"
        ? "Chalk can’t use your speaker. Check your browser’s audio permissions and system sound settings."
        : `Chalk can’t use your ${device(context)}. Click the camera icon in the address bar and allow ${context.source === "camera" ? "Camera" : context.source === "microphone" ? "Microphone" : "Camera and Microphone"}.`,
  ),
  "media.device_not_found": specific((context) => `No ${device(context)} found. Plug one in, or check that your Mac can see it in System Settings.`),
  "media.device_busy": { ...specific((context) => `Your ${device(context)} is being used by another app. Close it there${context.recoverable ? ", then try again" : ""}.`), retry: true },
  "media.device_constraint_invalid": specific((context) => `Your ${device(context)} doesn’t support these settings. Choose another ${device(context)}${context.recoverable ? ", then try again" : ""}.`),
  "media.capture_failed": { copy: { ...operationCopy, start: captureStart, request: captureStart, change: (context) => (context.source === "screen" ? `${settings(context)}${again(context)}` : capture(context)) }, retry: true },
  "media.request_invalid": {
    copy: {
      ...operationCopy,
      test: () => "The speaker test is no longer available.",
      request: () => "The media request is no longer active.",
      select: (context) => `Choose a valid ${device(context)} from the device list.`,
      start: () => "This media action is no longer available.",
      stop: () => "This media action is no longer available.",
      change: () => "This media action is no longer available.",
    },
    retry: false,
  },
  "media.timeout": generic,
  "offline.discarded": unavailable,
  "participant.invalid": unavailable,
  "reaction.invalid": unavailable,
  "whiteboard.unavailable": unavailable,
} satisfies Record<ErrorCode, Rule>;

export function commandFailurePresentation(failure: ClientFailure, source?: MediaCommandSource, operation: Operation = "change", hasExactRetry = false): { readonly message: string; readonly retry: boolean } {
  if (!source && operation === "change" && !failure.code.startsWith("media.")) return { message: failure.message, retry: false };
  const rule: Rule = MEDIA_FAILURE_POLICY[failure.code];
  const context = { source, recoverable: failure.recoverable };
  const message = rule.copy[operation](context);
  return { message, retry: failure.recoverable && rule.retry && hasExactRetry && source !== undefined && source !== "speaker" && (operation === "start" || operation === "stop") };
}

export function commandFailureMessage(failure: ClientFailure, source?: MediaCommandSource, operation?: MediaCommandAction): string {
  return commandFailurePresentation(failure, source, operation).message;
}
