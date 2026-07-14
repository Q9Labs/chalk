import { describe, expect, it } from "vitest";
import { createBrowserSyncLifecycle, createBrowserWebSocketFactory } from "./browser";

describe("browser sync boundaries", () => {
  it("adapts browser socket and lifecycle events through injected browser capabilities", () => {
    const socket = createBrowserWebSocketFactory(TestBrowserWebSocket as unknown as new (url: string) => WebSocket).connect("wss://sync.test/v3/sync");
    const events: string[] = [];
    socket.onopen = () => events.push("open");
    socket.onmessage = (event) => events.push(`message:${String(event.data)}`);
    socket.onclose = (event) => events.push(`close:${event.code}`);
    socket.onerror = () => events.push("error");
    const native = TestBrowserWebSocket.latest();
    native.open();
    native.message("frame");
    native.closeEvent(1012);
    native.error();
    socket.send("outbound");
    socket.close(1000, "done");

    const window = new EventTarget();
    const document = new TestDocument();
    document.hidden = true;
    const navigator = { onLine: false };
    const lifecycleEvents: string[] = [];
    const unsubscribe = createBrowserSyncLifecycle({ window, navigator }).subscribe((event) => lifecycleEvents.push(event));
    navigator.onLine = true;
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("offline"));
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    unsubscribe();
    window.dispatchEvent(new Event("online"));

    expect(events).toEqual(["open", "message:frame", "close:1012", "error"]);
    expect(native.sent).toEqual(["outbound"]);
    expect(native.closed).toEqual([1000, "done"]);
    expect(lifecycleEvents).toEqual(["offline", "online", "offline"]);
  });
});

class TestBrowserWebSocket extends EventTarget {
  static #sockets: TestBrowserWebSocket[] = [];
  readonly sent: string[] = [];
  closed: [number | undefined, string | undefined] | undefined;

  constructor(_: string) {
    super();
    TestBrowserWebSocket.#sockets.push(this);
  }

  static latest(): TestBrowserWebSocket {
    const socket = TestBrowserWebSocket.#sockets.at(-1);
    if (!socket) {
      throw new Error("missing browser socket");
    }
    return socket;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = [code, reason];
  }

  open(): void {
    this.dispatchEvent(new Event("open"));
  }

  message(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  closeEvent(code: number): void {
    const event = new Event("close");
    Object.defineProperty(event, "code", { value: code });
    this.dispatchEvent(event);
  }

  error(): void {
    this.dispatchEvent(new Event("error"));
  }
}

class TestDocument extends EventTarget {
  hidden = false;
}
