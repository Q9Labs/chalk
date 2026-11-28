export interface Listenable {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The browser objects this feature reads, so tests can fake them. */
export interface DevicePorts {
  readonly permissions: { query(descriptor: { readonly name: "microphone" | "camera" }): Promise<Listenable & { readonly state: string }> } | undefined;
  readonly mediaDevices: (Listenable & { enumerateDevices(): Promise<readonly { readonly kind: string }[]> }) | undefined;
  readonly userAgent: string;
  /** An iPad that asks for desktop sites reports a Mac, and only its touch screen tells them apart. */
  readonly touchPoints: number;
}
