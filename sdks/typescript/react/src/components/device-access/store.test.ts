import { SpaceClientError, type ErrorCode } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";
import { isDeviceAccessFailure } from "./model";
import type { DevicePorts, Listenable } from "./ports";
import { DeviceAccessStore } from "./store";

class FakeTarget implements Listenable {
  readonly #listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    this.#listeners.set(type, (this.#listeners.get(type) ?? new Set()).add(listener));
  }
  removeEventListener(type: string, listener: () => void) {
    this.#listeners.get(type)?.delete(listener);
  }
  emit(type: string) {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener();
  }
  count(type: string) {
    return this.#listeners.get(type)?.size ?? 0;
  }
}

class FakePermission extends FakeTarget {
  state: string;
  constructor(state: string) {
    super();
    this.state = state;
  }
  set(state: string) {
    this.state = state;
    this.emit("change");
  }
}

const ARM = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function setup(options: { permission?: string; devices?: string[]; userAgent?: string; askable?: boolean } = {}) {
  const permission = new FakePermission(options.permission ?? "denied");
  const mediaDevices = Object.assign(new FakeTarget(), { present: options.devices ?? [], enumerateDevices: async () => (mediaDevices.present ?? []).map((kind) => ({ kind })) });
  const window = new FakeTarget();
  const ports: DevicePorts = {
    permissions: options.askable === false ? undefined : { query: async () => permission },
    mediaDevices,
    window,
    userAgent: options.userAgent ?? ARM,
  };
  const store = new DeviceAccessStore(ports);
  const stop = store.subscribe(() => {});
  return { store, permission, mediaDevices, window, stop };
}

const failure = (code: ErrorCode, permissionBlock?: "system") => new SpaceClientError({ code, recoverable: true, message: code, permissionBlock });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DeviceAccessStore", () => {
  it("opens the browser card for a refused microphone", async () => {
    const { store } = setup();
    await store.report("microphone", failure("media.permission_denied"), async () => {});
    expect(store.getSnapshot().issues.microphone).toEqual({ reason: { kind: "blocked-browser", browser: "chrome" }, label: "Microphone is blocked. Click to fix.", open: true });
  });

  it("does not retry a refusal while the browser already says granted", async () => {
    const { store } = setup({ permission: "granted", userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36" });
    const retry = vi.fn(async () => {});
    await store.report("microphone", failure("media.permission_denied"), retry);
    await settle();
    expect(store.getSnapshot().issues.microphone?.reason.kind).toBe("blocked-browser");
    expect(retry).not.toHaveBeenCalled();
  });

  it("starts no watch when the last subscriber leaves while a report is still reading the permission", async () => {
    const { store, window, stop } = setup({ permission: "granted" });
    const reported = store.report("microphone", failure("media.permission_denied"), async () => {});
    stop();
    await reported;
    expect(store.getSnapshot().issues.microphone).toBeUndefined();
    expect(window.count("focus")).toBe(0);
  });

  it("retries the command when the person allows the site in browser settings", async () => {
    const { store, permission } = setup();
    const retry = vi.fn(async () => {});
    await store.report("microphone", failure("media.permission_denied"), retry);
    permission.set("granted");
    await settle();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("ignores a second recovery while the retry is still running", async () => {
    const { store, permission } = setup();
    let finish = () => {};
    const retry = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    await store.report("microphone", failure("media.permission_denied"), retry);
    permission.set("granted");
    permission.set("granted");
    await settle();
    expect(retry).toHaveBeenCalledTimes(1);
    finish();
  });

  it("retries a macOS block when the person returns to the tab", async () => {
    const { store, window } = setup({ permission: "granted" });
    const retry = vi.fn(async () => {});
    await store.report("camera", failure("media.permission_denied", "system"), retry);
    expect(store.getSnapshot().issues.camera?.reason).toMatchObject({ kind: "blocked-system", platform: "mac" });
    window.emit("focus");
    await settle();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("switches to a device that appears after none was found", async () => {
    const { store, mediaDevices } = setup();
    const retry = vi.fn(async () => {});
    await store.report("microphone", failure("media.device_not_found"), retry);
    mediaDevices.emit("devicechange");
    await settle();
    expect(retry).not.toHaveBeenCalled();
    mediaDevices.present = ["audioinput"];
    mediaDevices.emit("devicechange");
    await settle();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("ignores a device lookup that finishes after the last subscriber left", async () => {
    const { store, mediaDevices, stop } = setup();
    const retry = vi.fn(async () => {});
    await store.report("microphone", failure("media.device_not_found"), retry);
    let finish = () => {};
    mediaDevices.enumerateDevices = () => new Promise((resolve) => (finish = () => resolve([{ kind: "audioinput" }])));
    mediaDevices.emit("devicechange");
    stop();
    finish();
    await settle();
    expect(retry).not.toHaveBeenCalled();
  });

  it("clears the old card when the next failure is not an access problem", async () => {
    const { store } = setup();
    await store.report("microphone", failure("media.device_not_found"), async () => {});
    expect(store.getSnapshot().issues.microphone).toBeDefined();
    await store.report("microphone", failure("media.timeout"), async () => {});
    expect(store.getSnapshot().issues.microphone).toBeUndefined();
  });

  it("rejects a report that starts after the last subscriber left", async () => {
    const { store, stop, window } = setup({ permission: "granted" });
    const retry = vi.fn(async () => {});
    stop();
    await expect(store.report("camera", failure("media.permission_denied", "system"), retry)).rejects.toThrow();
    window.emit("focus");
    await settle();
    expect(retry).not.toHaveBeenCalled();
  });

  it("works in a browser that cannot be asked about permissions", async () => {
    const { store } = setup({ askable: false });
    await store.report("microphone", failure("media.permission_denied"), async () => {});
    expect(store.getSnapshot().issues.microphone?.reason.kind).toBe("blocked-browser");
  });

  it("drops a report that a newer command has replaced", async () => {
    const { store } = setup();
    const stale = store.report("microphone", failure("media.permission_denied"), async () => {});
    store.clear("microphone");
    await stale;
    expect(store.getSnapshot().issues.microphone).toBeUndefined();
  });

  it("clears the card and stops watching when the command works", async () => {
    const { store, permission } = setup();
    await settle();
    const watching = permission.count("change");
    await store.report("microphone", failure("media.permission_denied"), async () => {});
    expect(permission.count("change")).toBe(watching + 1);
    store.clear("microphone");
    expect(store.getSnapshot().issues.microphone).toBeUndefined();
    expect(permission.count("change")).toBe(watching);
  });

  it("keeps the issue when the card closes, and reopens it", async () => {
    const { store } = setup();
    await store.report("camera", failure("media.device_busy"), async () => {});
    store.setOpen("camera", false);
    expect(store.getSnapshot().issues.camera).toEqual({ reason: { kind: "busy" }, label: "Camera is in use. Click to fix.", open: false });
    store.setOpen("camera", true);
    expect(store.getSnapshot().issues.camera?.open).toBe(true);
  });

  it("shows nothing for a cancelled screen picker", async () => {
    const { store } = setup();
    await store.report("screen", failure("media.permission_denied"), async () => {});
    expect(store.getSnapshot().issues.screen).toBeUndefined();
  });

  it("stops every watcher when the last subscriber leaves", async () => {
    const { store, permission, window, stop } = setup({ permission: "granted" });
    await store.report("camera", failure("media.permission_denied", "system"), async () => {});
    stop();
    expect(permission.count("change")).toBe(0);
    expect(window.count("focus")).toBe(0);
  });
});

describe("commandFailurePresentation", () => {
  it("sends microphone, camera and screen permission failures to the card", () => {
    expect(isDeviceAccessFailure(failure("media.permission_denied"), "microphone")).toBe(true);
    expect(isDeviceAccessFailure(failure("media.device_busy"), "camera")).toBe(true);
    expect(isDeviceAccessFailure(failure("media.permission_denied"), "screen")).toBe(true);
  });

  it("keeps toasts for everything else", () => {
    expect(isDeviceAccessFailure(failure("media.device_busy"), "screen")).toBe(false);
    expect(isDeviceAccessFailure(failure("media.permission_denied"), "speaker")).toBe(false);
    expect(isDeviceAccessFailure(failure("client.internal_error"), "microphone")).toBe(false);
  });
});
