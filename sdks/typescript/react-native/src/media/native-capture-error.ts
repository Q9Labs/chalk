/**
 * `@cloudflare/react-native-webrtc` reports a denied microphone or camera as a `SecurityError`, which the
 * shared capture classifier reads as an unsupported environment. A denial is a `NotAllowedError` on the
 * web, so the native adapter gives it that name and the call can offer Open Settings.
 */
export function toNativeCaptureError(cause: unknown): unknown {
  if (!isNativePermissionDenial(cause)) return cause;
  return Object.assign(new Error(cause.message), { name: "NotAllowedError", cause });
}

function isNativePermissionDenial(cause: unknown): cause is { readonly name: "SecurityError"; readonly message: "Permission denied." } {
  return typeof cause === "object" && cause !== null && "name" in cause && cause.name === "SecurityError" && "message" in cause && cause.message === "Permission denied.";
}
