import type { ClientFailure } from "@q9labsai/chalk-client";
import { isDeviceAccessFailure, type DeviceAccessReason, type DeviceKind } from "./model";
import { loadDeviceAccessCard } from "./load-card";
import type { DevicePorts } from "./ports";

export interface DeviceIssue {
  readonly reason: DeviceAccessReason;
  readonly label: string;
  readonly open: boolean;
}

export interface DeviceAccessSnapshot {
  readonly issues: Readonly<Partial<Record<DeviceKind, DeviceIssue>>>;
}

/** What one device is waiting on: the newest report, the command to run again, and the listener that fixes it. */
interface Pending {
  attempt: number;
  retry?: () => Promise<unknown>;
  stop?: () => void;
  running?: boolean;
}

/**
 * Which device access problem each dock button has, and the listeners that fix it without a click.
 * Browser permission changes are only watched while something is subscribed.
 */
export class DeviceAccessStore {
  readonly #ports: DevicePorts | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<DeviceKind, Pending>();
  #snapshot: DeviceAccessSnapshot = { issues: {} };

  constructor(ports?: DevicePorts) {
    this.#ports = ports;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size > 0) return;
      for (const pending of this.#pending.values()) {
        pending.attempt++;
        pending.stop?.();
        pending.stop = undefined;
      }
    };
  };

  readonly getSnapshot = (): DeviceAccessSnapshot => this.#snapshot;

  /**
   * Shows the card for a failed command and starts watching for the fix. `retry` is the exact command that failed.
   * Rejects when the card code cannot load or no control bar is subscribed, so the caller can show the failure another way. Any other failure clears the old card.
   */
  async report(device: DeviceKind, failure: ClientFailure, retry: () => Promise<unknown>): Promise<void> {
    if (!isDeviceAccessFailure(failure, device)) return this.clear(device);
    const pending = this.#entry(device);
    const attempt = ++pending.attempt;
    // The card code loads with the resolver, so a failed download rejects here and the caller can show the toast instead.
    const [{ resolveAccess }] = await Promise.all([import("./resolve"), loadDeviceAccessCard()]);
    const resolved = await resolveAccess(this.#ports, device, failure);
    if (pending.attempt !== attempt) return;
    if (this.#listeners.size === 0) throw new Error("no subscriber");
    if (!resolved) return this.clear(device);
    const { reason, label, watch } = resolved;
    pending.stop?.();
    pending.retry = retry;
    pending.stop = watch(() => void this.retry(device));
    this.#set({ issues: { ...this.#snapshot.issues, [device]: { reason, label, open: true } } });
  }

  /** The command worked, or something else turned the device on. */
  clear(device: DeviceKind): void {
    const pending = this.#entry(device);
    pending.attempt++;
    pending.stop?.();
    pending.stop = pending.retry = undefined;
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
    const pending = this.#pending.get(device);
    if (!pending?.retry || pending.running) return;
    pending.running = true;
    try {
      await pending.retry();
    } finally {
      pending.running = false;
    }
  }

  #entry(device: DeviceKind): Pending {
    const found = this.#pending.get(device);
    if (found) return found;
    const created: Pending = { attempt: 0 };
    this.#pending.set(device, created);
    return created;
  }

  #set(change: Partial<DeviceAccessSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }
}
