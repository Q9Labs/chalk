import type { DeviceAccessReason, DeviceKind, PermissionAnswer } from "./model";

export interface Listenable {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The browser objects this feature reads, so tests can fake them. */
export interface DevicePorts {
  readonly permissions: { query(descriptor: { readonly name: "microphone" | "camera" }): Promise<Listenable & { readonly state: string }> } | undefined;
  readonly mediaDevices: (Listenable & { enumerateDevices(): Promise<readonly { readonly kind: string }[]> }) | undefined;
  readonly window: Listenable;
  readonly userAgent: string;
}

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

/** Browsers that cannot be asked about a device (Safari, older Firefox) answer "unknown". That is a real state here, not an error. */
export async function readPermission(ports: DevicePorts, device: "microphone" | "camera"): Promise<PermissionAnswer> {
  if (!ports.permissions) return "unknown";
  try {
    return answerOf((await ports.permissions.query({ name: device })).state);
  } catch {
    return "unknown";
  }
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
