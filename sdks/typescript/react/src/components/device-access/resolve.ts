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
    get userAgent() {
      return navigator.userAgent;
    },
    get touchPoints() {
      return navigator.maxTouchPoints;
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
 * A screen refusal without that signal is the person closing the browser picker, which a new attempt can fix. Phones have no screen share to refuse.
 */
/** Only for failures `isDeviceAccessFailure` accepts; the store checks that before it loads this file. */
export function deviceAccessReason(failure: ClientFailure, device: DeviceKind, environment: AccessEnvironment): DeviceAccessReason | null {
  const { browser, platform } = environment;
  if (failure.code === "media.device_busy") return { kind: "busy", platform };
  if (failure.code === "media.device_not_found") return { kind: "missing" };
  if (failure.code === "media.device_constraint_invalid") return { kind: "unavailable" };
  const system = failure.permissionBlock === "system" || (device !== "screen" && environment.permission === "granted");
  if (device === "screen") {
    if (platform === "ios" || platform === "android") return null;
    return system && platform === "mac" ? { kind: "blocked-system", platform, browser } : { kind: "screen-declined" };
  }
  if (platform === "ios") return browser === "safari" ? { kind: "blocked-browser", browser, platform } : { kind: "blocked-app", browser };
  if (system && (platform === "mac" || platform === "windows" || platform === "android")) return { kind: "blocked-system", platform, browser };
  return { kind: "blocked-browser", browser, platform };
}

export function detectBrowser(userAgent: string): BrowserName {
  if (/Firefox\/|FxiOS\//.test(userAgent)) return "firefox";
  if (/Edg(?:e|A|iOS)?\//.test(userAgent)) return "edge";
  if (/Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|CriOS\//.test(userAgent)) return "safari";
  return "chrome";
}

export function detectPlatform(userAgent: string, touchPoints = 0): Platform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  if (/Macintosh|Mac OS X/.test(userAgent)) return touchPoints > 1 ? "ios" : "mac";
  if (/Windows/.test(userAgent)) return "windows";
  return "other";
}

const KIND_OF = { microphone: "audioinput", camera: "videoinput" } as const;

/** When each device last looked for an input that was plugged in while its card was loading. One look per window stops a device that is listed but still refused from retrying forever. */
const lastLook: Partial<Record<DeviceKind, number>> = {};
const LOOK_WINDOW_MS = 10_000;

/**
 * Calls `recovered` when the cause of a blocked device has probably gone away, so the failed command can run again without a click.
 * The browser setting fires a permission change and a plugged-in device fires devicechange. A system setting fires neither, so the person retries it with a click; a window focus event is not a fix and would repeat the refusal.
 */
export function watchRecovery(ports: DevicePorts, device: DeviceKind, reason: DeviceAccessReason, observed: PermissionAnswer, recovered: () => void): () => void {
  if (device === "screen") return () => {};
  if (reason.kind === "blocked-browser" || reason.kind === "blocked-app") {
    // `observed` is the answer when the capture failed. Moving to "granted" from anything else counts, even if it happened before this watch began. A refusal with the permission already granted would retry forever.
    let before = observed;
    return watchPermission(ports, device, (answer) => {
      if (answer === "granted" && before !== "granted") recovered();
      before = answer;
    });
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
  const reason = deviceAccessReason(failure, device, { browser: detectBrowser(ports.userAgent), platform: detectPlatform(ports.userAgent, ports.touchPoints), permission });
  return reason && { reason, label: accessTooltip(device, reason), watch: (recovered) => watchRecovery(ports, device, reason, permission, recovered) };
}
