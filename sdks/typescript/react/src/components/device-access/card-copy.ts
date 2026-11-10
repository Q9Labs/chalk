import type { BrowserName, DeviceAccessReason, DeviceKind, Platform } from "./model";

export const DEVICE_NAMES = { microphone: "Microphone", camera: "Camera", screen: "Screen sharing" } as const satisfies Record<DeviceKind, string>;
const BROWSER_NAMES = { chrome: "Chrome", edge: "Edge", safari: "Safari", firefox: "Firefox" } as const satisfies Record<BrowserName, string>;

/** The operating system pane that holds the switch, when a link can open it. */
export function systemSettingsLink(device: DeviceKind, platform: Exclude<Platform, "other">): string | null {
  if (platform === "windows") return device === "microphone" ? "ms-settings:privacy-microphone" : device === "camera" ? "ms-settings:privacy-webcam" : null;
  const pane = device === "microphone" ? "Privacy_Microphone" : device === "camera" ? "Privacy_Camera" : "Privacy_ScreenCapture";
  return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
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

/** The dock button's tooltip and label while the card is available. */
export function accessTooltip(device: DeviceKind, reason: DeviceAccessReason): string {
  const name = DEVICE_NAMES[device];
  if (reason.kind === "busy") return `${name} is in use. Click to fix.`;
  if (reason.kind === "missing") return `No ${name.toLowerCase()} found. Click for details.`;
  return `${name} is blocked. Click to fix.`;
}
