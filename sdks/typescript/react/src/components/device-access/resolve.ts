import type { ClientFailure } from "@q9labsai/chalk-client";
import type { AccessEnvironment, BrowserName, DeviceAccessReason, DeviceKind, PermissionAnswer, Platform } from "./model";
import { accessTooltip } from "./card-copy";
import type { DevicePorts } from "./ports";

/** Reads the browser on use, so building it during server rendering is safe. */
export function browserPorts(): DevicePorts {
  return {
    get permissions() {
      return navigator.permissions;
    },
    get mediaDevices() {
      return navigator.mediaDevices;
    },
    get window() {
      return window;
    },
    get userAgent() {
      return navigator.userAgent;
    },
  };
}

function answerOf(state: string): PermissionAnswer {
  return state === "prompt" || state === "granted" || state === "denied" ? state : "unknown";
}

/** Calls `onAnswer` now and on every change. A browser that cannot be asked is never called back. */
export function watchPermission(ports: DevicePorts, device: "microphone" | "camera", onAnswer: (answer: PermissionAnswer) => void): () => void {
  let stopped = false;
  let release = () => {};
  void ports.permissions?.query({ name: device }).then(
    (status) => {
      if (stopped) return;
      const changed = () => onAnswer(answerOf(status.state));
      status.addEventListener("change", changed);
      release = () => status.removeEventListener("change", changed);
      changed();
    },
    () => undefined,
  );
  return () => {
    stopped = true;
    release();
  };
}

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
/** Only for failures `isDeviceAccessFailure` accepts; the store checks that before it loads this file. */
export function deviceAccessReason(failure: ClientFailure, device: DeviceKind, environment: AccessEnvironment): DeviceAccessReason | null {
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

/** When each device last looked for an input that was plugged in while its card was loading. One look per window stops a device that is listed but still refused from retrying forever. */
const lastLook: Partial<Record<DeviceKind, number>> = {};
const LOOK_WINDOW_MS = 10_000;

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
  let stopped = false;
  const changed = () =>
    void mediaDevices.enumerateDevices().then(
      (devices) => {
        if (!stopped && devices.some((entry) => entry.kind === KIND_OF[device])) recovered();
      },
      () => undefined,
    );
  mediaDevices.addEventListener("devicechange", changed);
  // An input plugged in while the card was loading fired its event before this listener existed.
  if (Date.now() - (lastLook[device] ?? 0) > LOOK_WINDOW_MS) {
    lastLook[device] = Date.now();
    changed();
  }
  return () => {
    stopped = true;
    mediaDevices.removeEventListener("devicechange", changed);
  };
}

export interface ResolvedAccess {
  readonly reason: DeviceAccessReason;
  readonly label: string;
  /** Starts watching for the fix. Returns the function that stops it. */
  readonly watch: (recovered: () => void) => () => void;
}

/** Everything the store needs to know about a failure, loaded on the first refusal so the call does not carry it. */
export async function resolveAccess(given: DevicePorts | undefined, device: DeviceKind, failure: ClientFailure): Promise<ResolvedAccess | null> {
  const ports = given ?? browserPorts();
  const permission = device === "screen" ? "unknown" : await readPermission(ports, device);
  const reason = deviceAccessReason(failure, device, { browser: detectBrowser(ports.userAgent), platform: detectPlatform(ports.userAgent), permission });
  return reason && { reason, label: accessTooltip(device, reason), watch: (recovered) => watchRecovery(ports, device, reason, recovered) };
}
