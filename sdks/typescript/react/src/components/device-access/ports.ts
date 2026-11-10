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
