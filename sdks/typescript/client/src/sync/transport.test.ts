import { afterEach, expect, it, vi } from "vitest";
import { createBrowserWebSocketFactory } from "./browser";
import { createReactNativeWebSocketFactory, type ReactNativeWebSocket } from "./react-native";

let browserSocket: EventTarget;
class BrowserSocket extends EventTarget {
  constructor() {
    super();
    browserSocket = this;
  }
}
let nativeSocket: NativeSocket;
class NativeSocket implements ReactNativeWebSocket {
  onopen: ReactNativeWebSocket["onopen"] = null;
  onmessage: ReactNativeWebSocket["onmessage"] = null;
  onclose: ReactNativeWebSocket["onclose"] = null;
  onerror: ReactNativeWebSocket["onerror"] = null;
  constructor() {
    nativeSocket = this;
  }
  send(): void {}
  close(): void {}
}
afterEach(() => vi.unstubAllGlobals());
it.each(["browser", "native", "native-browser-fallback"] as const)("preserves policy-close reasons through the %s transport", (platform) => {
  vi.stubGlobal("WebSocket", BrowserSocket);
  const factory = platform === "browser" ? createBrowserWebSocketFactory() : createReactNativeWebSocketFactory(platform === "native" ? NativeSocket : undefined);
  const socket = factory.connect("ws://sync.test/v1/sync");
  const closed = vi.fn();
  socket.onclose = closed;
  if (platform === "native") nativeSocket.onclose?.({ code: 1008, reason: "hello timeout" });
  else browserSocket.dispatchEvent(Object.assign(new Event("close"), { code: 1008, reason: "hello timeout" }));
  expect(closed).toHaveBeenCalledWith({ code: 1008, reason: "hello timeout" });
});
