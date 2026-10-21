import type { ErrorCode } from "@q9labsai/chalk-client";

const MEDIA_FAILURE_DETAILS: Readonly<Partial<Record<ErrorCode, string>>> = {
  "connection.invalid_state": "Still connecting. Try again in a moment.",
  "media.timeout": "The call did not respond. Try again.",
};

export function mediaFailureMessage(permission: "microphone" | "camera", code: ErrorCode | null): string {
  return (code && MEDIA_FAILURE_DETAILS[code]) || `Couldn’t turn on your ${permission}. Try again.`;
}
