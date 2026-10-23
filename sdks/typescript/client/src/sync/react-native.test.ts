import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactNativeWebSocketFactory } from "./react-native";
import type { ReactNativeWebSocket, ReactNativeWebSocketCloseEvent } from "./react-native";

class NativeSocket implements ReactNativeWebSocket {
  static latest: NativeSocket;
  onopen: ReactNativeWebSocket["onopen"] = null;
  onmessage: ReactNativeWebSocket["onmessage"] = null;
  onclose: ReactNativeWebSocket["onclose"] = null;
  onerror: ReactNativeWebSocket["onerror"] = null;
  constructor() {
    NativeSocket.latest = this;
  }
  send() {}
  close() {}
}
class BrowserSocket extends EventTarget {
  static latest: BrowserSocket;
  constructor() {
    super();
    BrowserSocket.latest = this;
  }
  send() {}
  close() {}
}
afterEach(() => vi.unstubAllGlobals());

describe("React Native Sync close events", () => {
  it("forwards the native close code and reason", () => {
    const socket = createReactNativeWebSocketFactory(NativeSocket).connect("wss://sync.test/v1/sync");
    const closed = vi.fn();
    socket.onclose = closed;
    NativeSocket.latest.onclose?.({ code: 1012, reason: "delivery recovery required" });
    expect(closed).toHaveBeenCalledWith({ code: 1012, reason: "delivery recovery required" });
  });
  it.each<ReactNativeWebSocketCloseEvent>([{ code: "invalid", reason: { token: "secret" } }, {}, { code: 1006, reason: 42 }])("ignores non-string native reason values", (event) => {
    const socket = createReactNativeWebSocketFactory(NativeSocket).connect("wss://sync.test/v1/sync");
    const closed = vi.fn();
    socket.onclose = closed;
    NativeSocket.latest.onclose?.(event);
    expect(closed.mock.lastCall?.[0].reason).toBeUndefined();
    expect(closed.mock.lastCall?.[0].code).toBe(1006);
  });
  it("forwards close reasons through the browser fallback", () => {
    vi.stubGlobal("WebSocket", BrowserSocket);
    const socket = createReactNativeWebSocketFactory().connect("wss://sync.test/v1/sync");
    const closed = vi.fn();
    socket.onclose = closed;
    BrowserSocket.latest.dispatchEvent(Object.assign(new Event("close"), { code: 1008, reason: "invalid token" }));
    expect(closed).toHaveBeenCalledWith({ code: 1008, reason: "invalid token" });
  });
});
