import { describe, expect, it } from "vitest";
import { createBrowserSyncLifecycle, createBrowserWebSocketFactory } from "./browser";

describe("browser sync boundaries", () => {
  it("adapts browser socket and lifecycle events through injected browser capabilities", () => {
    const socket = createBrowserWebSocketFactory(TestBrowserWebSocket).connect("wss://sync.test/v1/sync");
    const events: string[] = [];
    socket.onopen = () => events.push("open");
    socket.onmessage = (event) => events.push(`message:${String(event.data)}`);
    socket.onclose = (event) => events.push(`close:${event.code}`);
    socket.onerror = () => events.push("error");
    const native = TestBrowserWebSocket.latest();
    native.open();
    native.message("frame");
    socket.send("outbound");
    socket.close(1000, "done");
    expect(() => socket.send("late outbound")).toThrow("WebSocket is not open.");
    native.closeEvent(1012);
    native.error();

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

class TestBrowserWebSocket extends EventTarget implements WebSocket {
  static #sockets: TestBrowserWebSocket[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly sent: string[] = [];
  readonly url: string;
  readyState = 0;
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  binaryType: BinaryType = "blob";
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onopen: WebSocket["onopen"] = null;
  closed: [number | undefined, string | undefined] | undefined;

  constructor(url: string) {
    super();
    this.url = url;
    TestBrowserWebSocket.#sockets.push(this);
  }

  static latest(): TestBrowserWebSocket {
    const socket = TestBrowserWebSocket.#sockets.at(-1);
    if (!socket) {
      throw new Error("missing browser socket");
    }
    return socket;
  }

  send(data: Parameters<WebSocket["send"]>[0]): void {
    if (typeof data !== "string") throw new Error("test browser socket only accepts text frames");
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 2;
    this.closed = [code, reason];
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  message(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  closeEvent(code: number): void {
    this.readyState = 3;
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
