import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBrowserWebSocketFactory } from "../sync/browser";
import { createDirectFirstWebSocketFactory } from "../sync/direct-first";
import { preconnect, releasePreconnect } from "./preconnect";

type FakeLink = { rel: string; href: string; crossOrigin: string };

class FakeWebSocket extends EventTarget {
  static readonly instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  readonly closed: { code?: number; reason?: string }[] = [];
  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  fail(): void {
    this.dispatchEvent(new Event("error"));
  }
  send(data: string): void {
    this.sent.push(data);
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
  releasePreconnect();
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

it("carries the join on the lobby's socket: one socket takes the hello and every later frame", async () => {
  preconnect({ syncUrl });
  FakeWebSocket.instances[0]?.open();
  const socket = createBrowserWebSocketFactory().connect(dialed);
  socket.onopen = () => {
    socket.send('{"type":"hello"}');
  };
  await Promise.resolve();
  socket.send('{"type":"ping"}');
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(FakeWebSocket.instances[0]?.sent).toEqual(['{"type":"hello"}', '{"type":"ping"}']);
  expect(FakeWebSocket.instances[0]?.closed).toEqual([]);
});

it("does not take a second upgrade while the lobby socket is healthy, however often it is called", () => {
  preconnect({ syncUrl, keepWarmMs: 10_000 });
  FakeWebSocket.instances[0]?.open();
  for (let call = 0; call < 20; call++) preconnect({ syncUrl, keepWarmMs: 10_000 });
  expect(FakeWebSocket.instances).toHaveLength(1);
});

it("keeps a socket ready for a slow lobby and has the next call's socket ready after a leave", () => {
  preconnect({ syncUrl, keepWarmMs: 10_000 });
  FakeWebSocket.instances[0]?.open();
  vi.advanceTimersByTime(4000);
  FakeWebSocket.instances[1]?.open();
  const first = createBrowserWebSocketFactory().connect(dialed);
  first.onopen = vi.fn();
  expect(FakeWebSocket.instances).toHaveLength(2);
  // The call ends on the Sync side and closes that socket; the leave screen warms the next one.
  preconnect({ syncUrl, keepWarmMs: 10_000 });
  FakeWebSocket.instances[2]?.open();
  createBrowserWebSocketFactory().connect(dialed);
  expect(FakeWebSocket.instances).toHaveLength(3);
});

it("closes the lobby socket on release, as sign-out does", () => {
  preconnect({ syncUrl, keepWarmMs: 10_000 });
  FakeWebSocket.instances[0]?.open();
  releasePreconnect();
  expect(FakeWebSocket.instances[0]?.closed).toEqual([{ code: 1000, reason: "unused" }]);
  vi.advanceTimersByTime(30_000);
  expect(FakeWebSocket.instances).toHaveLength(1);
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

it("hands the socket over up to the last millisecond before it expires, and dials fresh from then on", () => {
  const factory = createBrowserWebSocketFactory();
  preconnect({ syncUrl });
  vi.advanceTimersByTime(3999);
  factory.connect(dialed);
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(FakeWebSocket.instances[0]?.closed).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(FakeWebSocket.instances[0]?.closed).toEqual([]);

  preconnect({ syncUrl });
  vi.advanceTimersByTime(4000);
  factory.connect(dialed);
  expect(FakeWebSocket.instances).toHaveLength(3);
  expect(FakeWebSocket.instances[1]?.closed).toEqual([{ code: 1000, reason: "unused" }]);
  expect(FakeWebSocket.instances[2]?.url).toBe(dialed);
});

it("does not close the socket after the client adopted it", () => {
  preconnect({ syncUrl });
  createBrowserWebSocketFactory().connect(dialed);
  vi.advanceTimersByTime(10_000);
  expect(FakeWebSocket.instances[0]?.closed).toEqual([]);
});

it("dials a new socket when the parked one is already closing", () => {
  preconnect({ syncUrl });
  const parked = FakeWebSocket.instances[0];
  if (parked) parked.readyState = 2;
  createBrowserWebSocketFactory().connect(dialed);
  expect(FakeWebSocket.instances).toHaveLength(2);
  expect(FakeWebSocket.instances[1]?.url).toBe(dialed);
});

it("drops a socket that errors, so the client dials its own and a later call parks a new one", () => {
  preconnect({ syncUrl });
  FakeWebSocket.instances[0]?.fail();
  createBrowserWebSocketFactory().connect(dialed);
  expect(FakeWebSocket.instances).toHaveLength(2);
  preconnect({ syncUrl });
  expect(FakeWebSocket.instances).toHaveLength(3);
});

it("drops a socket the server closes before the client dials", () => {
  preconnect({ syncUrl });
  FakeWebSocket.instances[0]?.close(1008, "hello timeout");
  createBrowserWebSocketFactory().connect(dialed);
  expect(FakeWebSocket.instances).toHaveLength(2);
});

it("keeps one socket and one hint when the page mounts twice and the name is edited many times", () => {
  for (let call = 0; call < 12; call += 1) preconnect({ baseUrl: "https://api.example.test", syncUrl });
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(links).toHaveLength(1);
});

it("parks a new socket for a call after the client adopted the first, and that one expires on its own", () => {
  preconnect({ syncUrl });
  createBrowserWebSocketFactory().connect(dialed);
  preconnect({ syncUrl });
  expect(FakeWebSocket.instances).toHaveLength(2);
  vi.advanceTimersByTime(4000);
  expect(FakeWebSocket.instances[1]?.closed).toEqual([{ code: 1000, reason: "unused" }]);
  expect(FakeWebSocket.instances[0]?.closed).toEqual([]);
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

const directUrl = "wss://direct.example.test/v1/sync";
const dialedDirect = dialed.replace("sync.example.test", "direct.example.test");

it("opens the lobby socket at the direct URL, where a direct-first client dials, and that client adopts it", async () => {
  preconnect({ syncUrl, syncDirectUrl: directUrl });
  expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual([dialedDirect]);
  FakeWebSocket.instances[0]?.open();
  const socket = createDirectFirstWebSocketFactory({ directUrl, inner: createBrowserWebSocketFactory(), memory: new Map() }).connect(dialed);
  const opened = vi.fn();
  socket.onopen = opened;
  await Promise.resolve();
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(opened).toHaveBeenCalledTimes(1);
});

it("keeps the Tunnel URL for the lobby socket when the client would not dial the direct URL first", () => {
  preconnect({ syncUrl, syncDirectUrl: "ws://direct.example.test/v1/sync" });
  expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual([dialed]);
});
