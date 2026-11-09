import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBrowserWebSocketFactory } from "../sync/browser";
import { preconnect } from "./preconnect";

type FakeLink = { rel: string; href: string; crossOrigin: string };

class FakeWebSocket extends EventTarget {
  static readonly instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly closed: { code?: number; reason?: string }[] = [];
  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed.push({ code, reason });
    this.dispatchEvent(new Event("close"));
  }
}

const syncUrl = "wss://sync.example.test/v1/sync";
const dialed = "wss://sync.example.test/v1/sync?participant_devices=1&participant_device_admissions=2&media_off_reason=1&entry_generation=new&entry_confirmation=1";
let links: FakeLink[];

beforeEach(() => {
  vi.useFakeTimers();
  links = [];
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("document", {
    createElement: () => ({ rel: "", href: "", crossOrigin: "" }),
    head: {
      appendChild: (link: FakeLink) => links.push(link),
      querySelector: (selector: string) => links.find((link) => selector === `link[rel="preconnect"][href="${link.href}"]`) ?? null,
    },
  });
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("hints the API origin once and opens one Sync socket at the URL the client dials", () => {
  preconnect({ baseUrl: "https://api.example.test/", syncUrl });
  preconnect({ baseUrl: "https://api.example.test/", syncUrl });
  expect(links).toEqual([{ rel: "preconnect", href: "https://api.example.test", crossOrigin: "anonymous" }]);
  expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual([dialed]);
});

it("derives the Sync URL from the base URL the way createSpaceClient does", () => {
  preconnect({ baseUrl: "https://api.example.test" });
  expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual([dialed]);
});

it("hands the opened socket to the client's first dial and tells it the socket is open", async () => {
  preconnect({ syncUrl });
  const parked = FakeWebSocket.instances[0];
  parked?.open();
  const socket = createBrowserWebSocketFactory().connect(dialed);
  const opened = vi.fn();
  socket.onopen = opened;
  await Promise.resolve();
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(opened).toHaveBeenCalledTimes(1);
});

it("lets a socket that is still upgrading finish for the client", () => {
  preconnect({ syncUrl });
  const socket = createBrowserWebSocketFactory().connect(dialed);
  const opened = vi.fn();
  socket.onopen = opened;
  FakeWebSocket.instances[0]?.open();
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(opened).toHaveBeenCalledTimes(1);
});

it("dials a new socket when the parked one is used, closed or for another URL", () => {
  preconnect({ syncUrl });
  const factory = createBrowserWebSocketFactory();
  factory.connect(dialed);
  factory.connect(dialed);
  expect(FakeWebSocket.instances).toHaveLength(2);
  preconnect({ syncUrl });
  FakeWebSocket.instances[2]?.close();
  factory.connect(dialed);
  expect(FakeWebSocket.instances).toHaveLength(4);
});

it("closes an unused socket before Sync's hello timeout, and a later call opens a new one", () => {
  preconnect({ syncUrl });
  vi.advanceTimersByTime(4000);
  expect(FakeWebSocket.instances[0]?.closed).toEqual([{ code: 1000, reason: "unused" }]);
  preconnect({ syncUrl });
  expect(FakeWebSocket.instances).toHaveLength(2);
});

it("leaves a socket from a custom WebSocket constructor alone", () => {
  preconnect({ syncUrl });
  class Custom extends FakeWebSocket {}
  createBrowserWebSocketFactory(Custom).connect(dialed);
  expect(FakeWebSocket.instances.filter((socket) => socket instanceof Custom)).toHaveLength(1);
});

it("does nothing outside a browser page", () => {
  vi.stubGlobal("document", undefined);
  preconnect({ syncUrl });
  expect(FakeWebSocket.instances).toHaveLength(0);
});
