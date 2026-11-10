import type { ClientFailure } from "@q9labsai/chalk-client";

export type DeviceKind = "microphone" | "camera" | "screen";
export type BrowserName = "chrome" | "edge" | "safari" | "firefox";
export type Platform = "mac" | "windows" | "other";
export type PermissionAnswer = "prompt" | "granted" | "denied" | "unknown";

export interface AccessEnvironment {
  readonly browser: BrowserName;
  readonly platform: Platform;
  /** The browser's own answer for this site. "unknown" when the browser cannot be asked. */
  readonly permission: PermissionAnswer;
}

/** The moments the card can show. Waiting and asking are not here: waiting has no card, and asking only happens on join. */
export type DeviceAccessReason = { readonly kind: "blocked-browser"; readonly browser: BrowserName } | { readonly kind: "blocked-system"; readonly platform: Exclude<Platform, "other">; readonly browser: BrowserName } | { readonly kind: "busy" } | { readonly kind: "missing" };

export const DEVICE_NAMES = { microphone: "Microphone", camera: "Camera", screen: "Screen sharing" } as const satisfies Record<DeviceKind, string>;

/**
 * Whether a failed command is shown by the card instead of a toast.
 * Screen sharing only ever has a permission failure here: the browser picker handles everything else.
 */
export function isDeviceAccessFailure(failure: ClientFailure, device: string | undefined): device is DeviceKind {
  if (device === "screen") return failure.code === "media.permission_denied";
  if (device !== "microphone" && device !== "camera") return false;
  return failure.code === "media.permission_denied" || failure.code === "media.device_busy" || failure.code === "media.device_not_found";
}

export function accessTooltip(device: DeviceKind, reason: DeviceAccessReason): string {
  const name = DEVICE_NAMES[device];
  if (reason.kind === "busy") return `${name} is in use. Click to fix.`;
  if (reason.kind === "missing") return `No ${name.toLowerCase()} found. Click for details.`;
  return `${name} is blocked. Click to fix.`;
}
