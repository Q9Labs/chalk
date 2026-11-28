import type { BrowserName, DeviceAccessReason, DeviceKind } from "./model";

export const DEVICE_NAMES = { microphone: "Microphone", camera: "Camera", screen: "Screen sharing" } as const satisfies Record<DeviceKind, string>;
export const BROWSER_NAMES = { chrome: "Chrome", edge: "Edge", safari: "Safari", firefox: "Firefox" } as const satisfies Record<BrowserName, string>;
/** The name macOS lists the browser under. */
export const APP_NAMES = { chrome: "Google Chrome", edge: "Microsoft Edge", safari: "Safari", firefox: "Firefox" } as const satisfies Record<BrowserName, string>;

/** The operating system pane that holds the switch, when a link can open it. */
export function systemSettingsLink(device: DeviceKind, platform: "mac" | "windows" | "android"): string | null {
  if (platform === "android") return null;
  if (platform === "windows") return device === "microphone" ? "ms-settings:privacy-microphone" : device === "camera" ? "ms-settings:privacy-webcam" : null;
  const pane = device === "microphone" ? "Privacy_Microphone" : device === "camera" ? "Privacy_Camera" : "Privacy_ScreenCapture";
  return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
}

/** Moving a switch in macOS needs the browser reopened, so a retry from the screen card cannot work. */
export function canRetryFromCard(device: DeviceKind, reason: DeviceAccessReason): boolean {
  if (reason.kind === "blocked-system") return !(device === "screen" && reason.platform === "mac");
  return reason.kind === "blocked-browser" || reason.kind === "blocked-app" || reason.kind === "screen-declined" || reason.kind === "busy";
}

export interface CardCopy {
  readonly title: string;
  readonly detail: string;
  /** Red glyph for problems the person must fix; plain glyph when Chalk fixes it by itself. */
  readonly danger: boolean;
  /** A short line under the actions, for a second route to the same switch. */
  readonly note?: string;
}

export function cardCopy(device: DeviceKind, reason: DeviceAccessReason): CardCopy {
  const name = DEVICE_NAMES[device];
  const lower = name.toLowerCase();
  switch (reason.kind) {
    case "blocked-browser": {
      const browser = BROWSER_NAMES[reason.browser];
      if (reason.platform === "ios") return { title: `${name} is blocked`, detail: `Safari is blocking ${lower} for this site. Allow it, then try again.`, danger: true, note: `Or open Settings › Safari › ${name}. On newer iPhones: Settings › Apps › Safari.` };
      if (reason.platform === "android") return { title: `${name} is blocked`, detail: `${browser} is blocking ${lower} for this site. Allow it, then try again.`, danger: true };
      return { title: `${name} is blocked`, detail: `Allow it for this site in ${browser}.`, danger: true };
    }
    case "blocked-app": {
      const browser = BROWSER_NAMES[reason.browser];
      return { title: `${name} is blocked`, detail: `${browser} needs ${lower} access. Turn it on in iPhone Settings, then come back and try again.`, danger: true, note: `iPhone Settings › ${browser}. On newer iPhones: Settings › Apps › ${browser}. ${browser} may reload after you change it.` };
    }
    case "blocked-system": {
      const browser = BROWSER_NAMES[reason.browser];
      if (reason.platform === "windows") return { title: "Blocked by Windows", detail: "Turn on access for desktop apps, then try again.", danger: true };
      if (reason.platform === "android") return { title: "Blocked by Android", detail: `Android is blocking ${lower} for ${browser}. Allow it, then try again.`, danger: true };
      return { title: device === "screen" ? "Screen sharing is blocked by macOS" : "Blocked by macOS", detail: `Turn on ${APP_NAMES[reason.browser]}, then quit and reopen ${browser}.`, danger: true };
    }
    case "busy":
      return { title: `${name} in use`, detail: reason.platform === "ios" || reason.platform === "android" ? `Another app, such as a call, has your ${lower}. End it, then try again.` : `Another app has your ${lower}. Close it, then try again.`, danger: true };
    case "missing":
      return { title: `No ${lower} found`, detail: "Connect one and Chalk switches to it.", danger: false };
    case "unavailable":
      return { title: `That ${lower} isn’t available`, detail: "It may be unplugged or turned off. Choose another, or use the default.", danger: true };
    case "screen-declined":
      return { title: "Screen sharing didn’t start", detail: "The picker was closed or refused. Choose a screen or window, then press Share.", danger: true };
  }
}

/** The dock button's tooltip and label while the card is available. */
export function accessTooltip(device: DeviceKind, reason: DeviceAccessReason): string {
  const name = DEVICE_NAMES[device];
  if (reason.kind === "busy") return `${name} is in use. Click to fix.`;
  if (reason.kind === "missing") return `No ${name.toLowerCase()} found. Click for details.`;
  if (reason.kind === "unavailable") return `${name} isn’t available. Click to fix.`;
  if (reason.kind === "screen-declined") return "Screen sharing didn’t start. Click for details.";
  return `${name} is blocked. Click to fix.`;
}
