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
export const BROWSER_NAMES = { chrome: "Chrome", edge: "Edge", safari: "Safari", firefox: "Firefox" } as const satisfies Record<BrowserName, string>;

/**
 * Whether a failed command is shown by the card instead of a toast.
 * Screen sharing only ever has a permission failure here: the browser picker handles everything else.
 */
export function isDeviceAccessFailure(failure: ClientFailure, device: string | undefined): device is DeviceKind {
  if (device === "screen") return failure.code === "media.permission_denied";
  if (device !== "microphone" && device !== "camera") return false;
  return failure.code === "media.permission_denied" || failure.code === "media.device_busy" || failure.code === "media.device_not_found";
}

/**
 * The card for one failure, or null when nothing should show.
 * A refusal while the browser says "granted" can only come from the operating system, and so can Chrome's "Permission denied by system".
 * A screen refusal without that signal is the person cancelling the browser picker.
 */
export function deviceAccessReason(failure: ClientFailure, device: DeviceKind, environment: AccessEnvironment): DeviceAccessReason | null {
  if (!isDeviceAccessFailure(failure, device)) return null;
  if (failure.code === "media.device_busy") return { kind: "busy" };
  if (failure.code === "media.device_not_found") return { kind: "missing" };
  const system = failure.permissionBlock === "system" || (device !== "screen" && environment.permission === "granted");
  if (device === "screen") return system && environment.platform === "mac" ? { kind: "blocked-system", platform: "mac", browser: environment.browser } : null;
  if (system && environment.platform !== "other") return { kind: "blocked-system", platform: environment.platform, browser: environment.browser };
  return { kind: "blocked-browser", browser: environment.browser };
}

export function detectBrowser(userAgent: string): BrowserName {
  if (/Firefox\/|FxiOS\//.test(userAgent)) return "firefox";
  if (/Edg(?:e|A|iOS)?\//.test(userAgent)) return "edge";
  if (/Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|CriOS\//.test(userAgent)) return "safari";
  return "chrome";
}

export function detectPlatform(userAgent: string): Platform {
  if (/iPhone|iPad|iPod|Android/.test(userAgent)) return "other";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "mac";
  if (/Windows/.test(userAgent)) return "windows";
  return "other";
}

/** The operating system pane that holds the switch, when a link can open it. */
export function systemSettingsLink(device: DeviceKind, platform: Exclude<Platform, "other">): string | null {
  if (platform === "windows") return device === "microphone" ? "ms-settings:privacy-microphone" : device === "camera" ? "ms-settings:privacy-webcam" : null;
  const pane = device === "microphone" ? "Privacy_Microphone" : device === "camera" ? "Privacy_Camera" : "Privacy_ScreenCapture";
  return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
}

export function accessTooltip(device: DeviceKind, reason: DeviceAccessReason): string {
  const name = DEVICE_NAMES[device];
  if (reason.kind === "busy") return `${name} is in use. Click to fix.`;
  if (reason.kind === "missing") return `No ${name.toLowerCase()} found. Click for details.`;
  return `${name} is blocked. Click to fix.`;
}

export interface CardCopy {
  readonly title: string;
  readonly detail: string;
  /** Red glyph for problems the person must fix; plain glyph when Chalk fixes it by itself. */
  readonly danger: boolean;
}

export function cardCopy(device: DeviceKind, reason: DeviceAccessReason): CardCopy {
  const name = DEVICE_NAMES[device];
  switch (reason.kind) {
    case "blocked-browser":
      return { title: `${name} is blocked`, detail: `Allow it for this site in ${BROWSER_NAMES[reason.browser]}.`, danger: true };
    case "blocked-system": {
      const app = BROWSER_NAMES[reason.browser];
      const where = reason.platform === "mac" ? "System Settings" : "Settings";
      return { title: `Blocked by ${reason.platform === "mac" ? "macOS" : "Windows"}`, detail: device === "screen" ? `Turn on ${app}, then reopen it.` : `Turn on ${app} in ${where}.`, danger: true };
    }
    case "busy":
      return { title: `${name} in use`, detail: "Another app has it. Close it there, then try again.", danger: true };
    case "missing":
      return { title: `No ${name.toLowerCase()} found`, detail: "Connect one and Chalk switches to it.", danger: false };
  }
}
