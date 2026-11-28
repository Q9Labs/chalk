import { describe, expect, it, vi } from "vitest";
import type { ClientFailure } from "@q9labsai/chalk-client";
import { resolveAccess } from "./resolve";
import { DeviceAccessStore } from "./store";
import type { DevicePorts } from "./ports";

const denied: ClientFailure = { code: "media.permission_denied", message: "Microphone permission was denied", recoverable: true } as ClientFailure;

function ports(state: string) {
  const status = Object.assign(new EventTarget(), { state });
  const devicePorts: DevicePorts = {
    permissions: { query: async () => status },
    mediaDevices: undefined,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    touchPoints: 0,
  };
  return { devicePorts, status };
}

async function reported(devicePorts: DevicePorts, retry: () => Promise<unknown>) {
  const store = new DeviceAccessStore(devicePorts, async () => ({ resolveAccess }));
  store.subscribe(() => undefined);
  await store.report("microphone", denied, retry);
  return store;
}

describe("a refused microphone", () => {
  it("is not retried when the page regains focus", async () => {
    const { devicePorts } = ports("granted");
    const retries: number[] = [];
    const retry = async () => void retries.push(retries.length);
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    await reported(devicePorts, retry);
    page.dispatchEvent(new Event("focus"));
    vi.unstubAllGlobals();
    expect(retries).toHaveLength(0);
  });

  it("is retried once when the browser permission turns granted", async () => {
    const { devicePorts, status } = ports("denied");
    const retries: number[] = [];
    const retry = async () => void retries.push(retries.length);
    await reported(devicePorts, retry);
    status.state = "granted";
    status.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(retries).toHaveLength(1));
  });

  it("says it is still blocked only after a retry that failed", async () => {
    const { devicePorts } = ports("denied");
    const retries: number[] = [];
    const retry = async () => void retries.push(retries.length);
    const store = await reported(devicePorts, retry);
    expect(store.getSnapshot().issues.microphone?.stillBlocked).toBe(false);
    await store.retry("microphone");
    await store.report("microphone", denied, retry);
    expect(store.getSnapshot().issues.microphone?.stillBlocked).toBe(true);
    store.clear("microphone");
    await store.report("microphone", denied, retry);
    expect(store.getSnapshot().issues.microphone?.stillBlocked).toBe(false);
  });

  it("is retried on the person's request, one run at a time", async () => {
    const { devicePorts } = ports("denied");
    const retries: number[] = [];
    const retry = async () => void retries.push(retries.length);
    const store = await reported(devicePorts, retry);
    await Promise.all([store.retry("microphone"), store.retry("microphone")]);
    expect(retries).toHaveLength(1);
  });
});
