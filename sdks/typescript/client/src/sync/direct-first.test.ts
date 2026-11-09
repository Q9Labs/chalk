import { describe, expect, it } from "vitest";
import { createDirectFirstWebSocketFactory, directFirstSyncOptions } from "./direct-first";
import type { SyncSocket, SyncWebSocketFactory } from "./types";

const TUNNEL = "wss://tunnel.example.test/v1/sync?entry_generation=new&entry_confirmation=1";
const DIRECT = "wss://direct.example.test/v1/sync";
const DIRECT_ATTEMPT = "wss://direct.example.test/v1/sync?entry_generation=new&entry_confirmation=1";

class FakeSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: SyncSocket["onclose"] = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

function harness(options: { readonly innerThrowsFor?: (url: string) => boolean } = {}) {
  const sockets: FakeSocket[] = [];
  let now = 1_000;
  const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  let nextTimer = 0;
  const inner: SyncWebSocketFactory = {
    connect(url) {
      if (options.innerThrowsFor?.(url)) throw new Error("socket constructor failed");
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  };
  const clock = {
    now: () => now,
    setTimeout: (callback: () => void, milliseconds: number) => {
      timers.set(++nextTimer, { at: now + milliseconds, callback });
      return nextTimer;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
  };
  const advance = (milliseconds: number) => {
    now += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  const factory = () => createDirectFirstWebSocketFactory({ directUrl: DIRECT, inner, clock, memory });
  const memory = new Map<string, number>();
  return { sockets, advance, factory, memory, urls: () => sockets.map((socket) => socket.url) };
}

describe("direct-first Sync socket", () => {
  it("leaves the client options untouched while no direct URL is configured", () => {
    const inner = harness().factory();
    expect(directFirstSyncOptions(undefined, inner)).toEqual({});
    expect(directFirstSyncOptions(null, inner)).toEqual({});
    expect(directFirstSyncOptions("", inner)).toEqual({});
    expect(directFirstSyncOptions(DIRECT, inner).webSocket).toBeDefined();
  });

  it("uses the direct socket when it opens and never touches the Tunnel", () => {
    const { sockets, factory, urls } = harness();
    const socket = factory().connect(TUNNEL);
    const events: string[] = [];
    socket.onopen = () => events.push("open");
    socket.onmessage = (event) => events.push(`message:${String(event.data)}`);

    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: "welcome" });
    socket.send("hello");

    expect(urls()).toEqual([DIRECT_ATTEMPT]);
    expect(events).toEqual(["open", "message:welcome"]);
    expect(sockets[0]!.sent).toEqual(["hello"]);
  });

  it("falls back to the Tunnel when the direct socket errors before it opens", () => {
    const { sockets, factory, urls } = harness();
    const socket = factory().connect(TUNNEL);
    const events: string[] = [];
    socket.onopen = () => events.push("open");
    socket.onerror = () => events.push("error");
    socket.onclose = () => events.push("close");

    sockets[0]!.onerror?.();
    sockets[0]!.onclose?.({ code: 1006, wasClean: false });
    expect(urls()).toEqual([DIRECT_ATTEMPT, TUNNEL]);
    expect(sockets[0]!.closed).toBe(true);
    expect(events).toEqual([]);

    sockets[1]!.onopen?.();
    socket.send("hello");
    expect(events).toEqual(["open"]);
    expect(sockets[1]!.sent).toEqual(["hello"]);
  });

  it("treats a TLS failure like any other direct connect failure", () => {
    const { sockets, factory, urls, memory } = harness();
    const socket = factory().connect(TUNNEL);
    // Browsers hide the certificate error: the socket closes with 1006 and never opens.
    sockets[0]!.onclose?.({ code: 1006, reason: "", wasClean: false });

    expect(urls()).toEqual([DIRECT_ATTEMPT, TUNNEL]);
    expect(memory.get("direct.example.test")).toBeGreaterThan(1_001);
    sockets[1]!.onopen?.();
    socket.close();
  });

  it("falls back after the bounded direct timeout and ignores a late direct open", () => {
    const { sockets, factory, advance, urls } = harness();
    const socket = factory().connect(TUNNEL);
    const events: string[] = [];
    socket.onopen = () => events.push("open");

    advance(2_499);
    expect(urls()).toEqual([DIRECT_ATTEMPT]);
    advance(1);
    expect(urls()).toEqual([DIRECT_ATTEMPT, TUNNEL]);
    expect(sockets[0]!.closed).toBe(true);

    sockets[0]!.onopen?.();
    expect(events).toEqual([]);
    sockets[1]!.onopen?.();
    expect(events).toEqual(["open"]);
  });

  it("skips the direct path for a bounded time after a failure, then tries it again", () => {
    const { sockets, factory, advance, urls } = harness();
    const connect = factory();
    connect.connect(TUNNEL);
    advance(2_500);
    sockets[1]!.onopen?.();

    connect.connect(TUNNEL);
    expect(urls()).toEqual([DIRECT_ATTEMPT, TUNNEL, TUNNEL]);

    advance(10 * 60_000);
    connect.connect(TUNNEL);
    expect(urls().at(-1)).toBe(DIRECT_ATTEMPT);
  });

  it("drops expired failed hosts from the memory when another failure is recorded", () => {
    const { factory, advance, memory } = harness();
    memory.set("old.example.test", 1_500);
    advance(1_000);
    factory().connect(TUNNEL);
    advance(2_500);

    expect([...memory.keys()]).toEqual(["direct.example.test"]);
  });

  it("does not remember a direct socket that opened and later dropped", () => {
    const { sockets, factory, urls } = harness();
    const connect = factory();
    const socket = connect.connect(TUNNEL);
    const closes: number[] = [];
    socket.onclose = (event) => closes.push(event.code);
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: "welcome" });
    sockets[0]!.onclose?.({ code: 1006, wasClean: false });

    expect(closes).toEqual([1006]);
    connect.connect(TUNNEL);
    expect(urls()).toEqual([DIRECT_ATTEMPT, DIRECT_ATTEMPT]);
  });

  it("moves to the Tunnel when the direct proxy is over its bound before any frame", () => {
    const { sockets, factory, urls } = harness();
    const connect = factory();
    const socket = connect.connect(TUNNEL);
    const closes: number[] = [];
    socket.onclose = (event) => closes.push(event.code);
    sockets[0]!.onopen?.();
    sockets[0]!.onclose?.({ code: 1013, reason: "try again later", wasClean: true });

    expect(closes).toEqual([1013]);
    connect.connect(TUNNEL);
    expect(urls()).toEqual([DIRECT_ATTEMPT, TUNNEL]);
  });

  it("falls back when the direct socket cannot even be constructed", () => {
    const { factory, urls } = harness({ innerThrowsFor: (url) => url.startsWith("wss://direct.") });
    factory().connect(TUNNEL);
    expect(urls()).toEqual([TUNNEL]);
  });

  it("does not fall back when the client closes the socket while the direct attempt is pending", () => {
    const { sockets, factory, advance, urls } = harness();
    const socket = factory().connect(TUNNEL);
    socket.close(1000, "done");
    advance(5_000);

    expect(urls()).toEqual([DIRECT_ATTEMPT]);
    expect(sockets[0]!.closed).toBe(true);
  });

  it("still reports the close event after the client closes the socket, as a heartbeat timeout does", () => {
    const { sockets, factory, urls } = harness();
    const socket = factory().connect(TUNNEL);
    const closes: number[] = [];
    socket.onclose = (event) => closes.push(event.code);

    sockets[0]!.onopen?.();
    socket.close(4000, "heartbeat timeout");
    sockets[0]!.onclose?.({ code: 4000, wasClean: true });

    expect(closes).toEqual([4000]);
    expect(urls()).toEqual([DIRECT_ATTEMPT]);
  });

  it("reports the close of a pending direct attempt the client already gave up on, without a fallback", () => {
    const { sockets, factory, urls } = harness();
    const socket = factory().connect(TUNNEL);
    const closes: number[] = [];
    socket.onclose = (event) => closes.push(event.code);

    socket.close(1000, "done");
    sockets[0]!.onclose?.({ code: 1006, wasClean: false });

    expect(closes).toEqual([1006]);
    expect(urls()).toEqual([DIRECT_ATTEMPT]);
  });

  it("reports a closed Tunnel socket when both paths fail", () => {
    const { sockets, factory } = harness();
    const socket = factory().connect(TUNNEL);
    const closes: number[] = [];
    socket.onclose = (event) => closes.push(event.code);

    sockets[0]!.onerror?.();
    sockets[1]!.onclose?.({ code: 1006, wasClean: false });
    expect(closes).toEqual([1006]);
  });
});
