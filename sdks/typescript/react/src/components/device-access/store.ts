import type { ClientFailure } from "@q9labsai/chalk-client";
import { deviceAccessReason, detectBrowser, detectPlatform, isDeviceAccessFailure, type DeviceAccessReason, type DeviceKind, type PermissionAnswer } from "./model";
import { readPermission, watchPermission, watchRecovery, type DevicePorts } from "./ports";

export interface DeviceIssue {
  readonly reason: DeviceAccessReason;
  readonly open: boolean;
}

export interface DeviceAccessSnapshot {
  readonly issues: Readonly<Partial<Record<DeviceKind, DeviceIssue>>>;
  /** What the browser says right now, for the two devices it can be asked about. */
  readonly permissions: Readonly<Record<"microphone" | "camera", PermissionAnswer>>;
}

const PROMPTABLE = ["microphone", "camera"] as const;

/**
 * Which device access problem each dock button has, and the listeners that fix it without a click.
 * Browser permission changes are only watched while something is subscribed.
 */
export class DeviceAccessStore {
  readonly #ports: DevicePorts;
  readonly #listeners = new Set<() => void>();
  readonly #recoveries = new Map<DeviceKind, () => void>();
  readonly #retries = new Map<DeviceKind, () => Promise<unknown>>();
  readonly #running = new Set<DeviceKind>();
  readonly #attempt = new Map<DeviceKind, number>();
  #stopPermissionWatch: readonly (() => void)[] = [];
  #snapshot: DeviceAccessSnapshot = { issues: {}, permissions: { microphone: "unknown", camera: "unknown" } };

  constructor(ports: DevicePorts) {
    this.#ports = ports;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#stopPermissionWatch = PROMPTABLE.map((device) => watchPermission(this.#ports, device, (answer) => this.#set({ permissions: { ...this.#snapshot.permissions, [device]: answer } })));
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size > 0) return;
      for (const stop of this.#stopPermissionWatch) stop();
      this.#stopPermissionWatch = [];
      for (const device of this.#recoveries.keys()) this.#forget(device);
      for (const device of [...this.#attempt.keys()]) this.#nextAttempt(device);
    };
  };

  readonly getSnapshot = (): DeviceAccessSnapshot => this.#snapshot;

  /** Shows the card for a failed command and starts watching for the fix. `retry` is the exact command that failed. */
  async report(device: DeviceKind, failure: ClientFailure, retry: () => Promise<unknown>): Promise<void> {
    if (!isDeviceAccessFailure(failure, device)) return;
    const attempt = this.#nextAttempt(device);
    const permission = device === "screen" ? "unknown" : await readPermission(this.#ports, device);
    if (this.#attempt.get(device) !== attempt) return;
    const reason = deviceAccessReason(failure, device, { browser: detectBrowser(this.#ports.userAgent), platform: detectPlatform(this.#ports.userAgent), permission });
    if (!reason) {
      this.clear(device);
      return;
    }
    this.#retries.set(device, retry);
    this.#recoveries.get(device)?.();
    this.#recoveries.set(
      device,
      watchRecovery(this.#ports, device, reason, () => void this.retry(device)),
    );
    this.#set({ issues: { ...this.#snapshot.issues, [device]: { reason, open: true } } });
  }

  /** The command worked, or something else turned the device on. */
  clear(device: DeviceKind): void {
    this.#nextAttempt(device);
    this.#forget(device);
    if (!this.#snapshot.issues[device]) return;
    const { [device]: _cleared, ...issues } = this.#snapshot.issues;
    this.#set({ issues });
  }

  setOpen(device: DeviceKind, open: boolean): void {
    const issue = this.#snapshot.issues[device];
    if (issue && issue.open !== open) this.#set({ issues: { ...this.#snapshot.issues, [device]: { ...issue, open } } });
  }

  /** Runs the failed command again. A second request while one is running is ignored. */
  async retry(device: DeviceKind): Promise<void> {
    const retry = this.#retries.get(device);
    if (!retry || this.#running.has(device)) return;
    this.#running.add(device);
    try {
      await retry();
    } finally {
      this.#running.delete(device);
    }
  }

  #nextAttempt(device: DeviceKind): number {
    const attempt = (this.#attempt.get(device) ?? 0) + 1;
    this.#attempt.set(device, attempt);
    return attempt;
  }

  #forget(device: DeviceKind): void {
    this.#recoveries.get(device)?.();
    this.#recoveries.delete(device);
    this.#retries.delete(device);
  }

  #set(change: Partial<DeviceAccessSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }
}
