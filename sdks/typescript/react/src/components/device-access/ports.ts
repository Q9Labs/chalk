import type { PermissionAnswer } from "./model";

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

export function answerOf(state: string): PermissionAnswer {
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
