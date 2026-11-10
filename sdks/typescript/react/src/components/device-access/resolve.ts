import type { ClientFailure } from "@q9labsai/chalk-client";
import { isDeviceAccessFailure, type AccessEnvironment, type BrowserName, type DeviceAccessReason, type DeviceKind, type PermissionAnswer, type Platform } from "./model";
import { answerOf, watchPermission, type DevicePorts } from "./ports";

/** Browsers that cannot be asked about a device (Safari, older Firefox) answer "unknown". That is a real state here, not an error. */
export async function readPermission(ports: DevicePorts, device: "microphone" | "camera"): Promise<PermissionAnswer> {
  if (!ports.permissions) return "unknown";
  try {
    return answerOf((await ports.permissions.query({ name: device })).state);
  } catch {
    return "unknown";
  }
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

const KIND_OF = { microphone: "audioinput", camera: "videoinput" } as const;

/**
 * Calls `recovered` when the cause of a blocked device has probably gone away, so the failed command can run again without a click.
 * The browser setting fires a permission change, a plugged-in device fires devicechange, and a Mac setting only shows when the person comes back to the tab.
 */
export function watchRecovery(ports: DevicePorts, device: DeviceKind, reason: DeviceAccessReason, recovered: () => void): () => void {
  if (device === "screen") return () => {};
  if (reason.kind === "blocked-browser") {
    // watchPermission reports the current answer first. Only a change after that counts, or a refusal with the permission already granted would retry forever.
    let current = true;
    return watchPermission(ports, device, (answer) => {
      if (current) current = false;
      else if (answer === "granted") recovered();
    });
  }
  if (reason.kind === "blocked-system") {
    ports.window.addEventListener("focus", recovered);
    return () => ports.window.removeEventListener("focus", recovered);
  }
  if (reason.kind !== "missing" || !ports.mediaDevices) return () => {};
  const mediaDevices = ports.mediaDevices;
  const changed = () =>
    void mediaDevices.enumerateDevices().then(
      (devices) => {
        if (devices.some((entry) => entry.kind === KIND_OF[device])) recovered();
      },
      () => undefined,
    );
  mediaDevices.addEventListener("devicechange", changed);
  return () => mediaDevices.removeEventListener("devicechange", changed);
}

export interface ResolvedAccess {
  readonly reason: DeviceAccessReason;
  /** Starts watching for the fix. Returns the function that stops it. */
  readonly watch: (recovered: () => void) => () => void;
}

/** Everything the store needs to know about a failure, loaded on the first refusal so the call does not carry it. */
export async function resolveAccess(ports: DevicePorts, device: DeviceKind, failure: ClientFailure): Promise<ResolvedAccess | null> {
  const permission = device === "screen" ? "unknown" : await readPermission(ports, device);
  const reason = deviceAccessReason(failure, device, { browser: detectBrowser(ports.userAgent), platform: detectPlatform(ports.userAgent), permission });
  return reason && { reason, watch: (recovered) => watchRecovery(ports, device, reason, recovered) };
}
