/** Capture failures describe the recovery, without exposing device labels. */
export function describeMediaCaptureError(cause: unknown) {
  const name = typeof cause === "object" && cause !== null && "name" in cause ? cause.name : undefined;
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return { code: "permission_denied", recoverable: true, message: "Camera or microphone permission was denied. Allow access in your device settings and try again." } as const;
    case "NotFoundError":
    case "DevicesNotFoundError":
      return { code: "device_not_found", recoverable: true, message: "No matching camera or microphone was found. Connect an input device or enter with that device off." } as const;
    case "NotReadableError":
    case "TrackStartError":
      return { code: "device_busy", recoverable: true, message: "The camera or microphone could not start. Close other apps using it and try again." } as const;
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return { code: "device_constraint_invalid", recoverable: true, message: "The selected camera or microphone is unavailable. Select another input device and try again." } as const;
    case "SecurityError":
    case "NotSupportedError":
      return { code: "unsupported_environment", recoverable: false, message: "Media capture is unavailable in this environment. Use a supported browser over HTTPS or the native app." } as const;
    default:
      return { code: "media_capture_failed", recoverable: true, message: "Media capture failed. Try again or enter with devices off." } as const;
  }
}

const CAUSE_DEPTH = 4;

/** Chrome reports an operating-system refusal as a NotAllowedError whose message ends "by system". Other browsers give no such signal, so absence means unknown, not browser. */
export function permissionBlockOf(cause: unknown): "system" | undefined {
  let current = cause;
  for (let depth = 0; depth < CAUSE_DEPTH && current instanceof Error; depth++) {
    if (current.name === "NotAllowedError" && /by system/i.test(current.message)) return "system";
    current = current.cause;
  }
  return undefined;
}
