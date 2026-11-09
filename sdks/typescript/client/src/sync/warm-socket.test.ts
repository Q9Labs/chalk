import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_KEEP_WARM_MS, WARM_SOCKET_TTL_MS, WarmSocketSlot } from "./warm-socket";

class FakeSocket extends EventTarget {
  readyState = 0;
  readonly closed: { code?: number; reason?: string }[] = [];
  constructor(readonly url: string) {
    super();
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  fail(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("error"));
    this.dispatchEvent(new Event("close"));
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed.push({ code, reason });
    this.dispatchEvent(new Event("close"));
  }
}

const url = "wss://sync.example.test/v1/sync?entry_generation=new";
let sockets: FakeSocket[];
let visible: boolean;
let slot: WarmSocketSlot;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  visible = true;
  slot = new WarmSocketSlot({
    open: (target) => {
      const socket = new FakeSocket(target);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    visible: () => visible,
  });
});
afterEach(() => {
  slot.release();
  vi.useRealTimers();
});

it("moves from empty to upgrading to ready, and hands the socket to the client that dials it", () => {
  expect(slot.state).toBe("empty");
  slot.warm(url);
  expect(slot.state).toBe("upgrading");
  sockets[0]?.open();
  expect(slot.state).toBe("ready");
  expect(slot.adopt(url)).toBe(sockets[0]);
  expect(slot.state).toBe("empty");
  expect(sockets[0]?.closed).toEqual([]);
});

it("takes no new upgrade while the socket is upgrading or open", () => {
  slot.warm(url, 10_000);
  slot.warm(url, 10_000);
  sockets[0]?.open();
  slot.warm(url, 10_000);
  vi.advanceTimersByTime(WARM_SOCKET_TTL_MS - 1);
  slot.warm(url, 10_000);
  expect(sockets).toHaveLength(1);
});

it("lets a socket age out when no keep window was asked for", () => {
  slot.warm(url);
  sockets[0]?.open();
  vi.advanceTimersByTime(WARM_SOCKET_TTL_MS);
  expect(sockets[0]?.closed).toEqual([{ code: 1000, reason: "unused" }]);
  vi.advanceTimersByTime(60_000);
  expect(sockets).toHaveLength(1);
  expect(slot.state).toBe("empty");
});

it("keeps a socket ready through the keep window by replacing each one that ages out, then stops", () => {
  slot.warm(url, 10_000);
  sockets[0]?.open();
  vi.advanceTimersByTime(WARM_SOCKET_TTL_MS);
  expect(sockets).toHaveLength(2);
  sockets[1]?.open();
  vi.advanceTimersByTime(WARM_SOCKET_TTL_MS);
  expect(sockets).toHaveLength(3);
  vi.advanceTimersByTime(WARM_SOCKET_TTL_MS);
  expect(sockets).toHaveLength(3);
  expect(slot.state).toBe("empty");
});

it("bounds the keep window however long the caller asks for", () => {
  slot.warm(url, Number.MAX_SAFE_INTEGER);
  vi.advanceTimersByTime(10 * MAX_KEEP_WARM_MS);
  expect(sockets.length).toBeLessThanOrEqual(MAX_KEEP_WARM_MS / WARM_SOCKET_TTL_MS + 1);
  expect(slot.state).toBe("empty");
});

it("serves the next call: a client adopts one socket per join, and a new one is warmed for the one after", () => {
  slot.warm(url);
  sockets[0]?.open();
  expect(slot.adopt(url)).toBe(sockets[0]);
  slot.warm(url);
  sockets[1]?.open();
  vi.advanceTimersByTime(WARM_SOCKET_TTL_MS - 1);
  expect(slot.adopt(url)).toBe(sockets[1]);
  expect(sockets).toHaveLength(2);
  expect(slot.adopt(url)).toBeUndefined();
});

it("closes on release and stops keeping one", () => {
  slot.warm(url, 10_000);
  sockets[0]?.open();
  slot.release();
  expect(sockets[0]?.closed).toEqual([{ code: 1000, reason: "unused" }]);
  vi.advanceTimersByTime(60_000);
  expect(sockets).toHaveLength(1);
  expect(slot.state).toBe("empty");
});

it("replaces a socket that closed or errored, and only then", () => {
  slot.warm(url);
  sockets[0]?.open();
  sockets[0]?.fail();
  expect(slot.state).toBe("empty");
  expect(slot.adopt(url)).toBeUndefined();
  slot.warm(url);
  expect(sockets).toHaveLength(2);
  sockets[1]?.open();
  // The browser reports a dead socket's state before it dispatches the event.
  if (sockets[1]) sockets[1].readyState = 3;
  slot.warm(url);
  expect(sockets).toHaveLength(3);
  expect(sockets[1]?.closed).toHaveLength(1);
});

it("does not loop after a failure: a failed upgrade ends the keep window", () => {
  slot.warm(url, 10_000);
  sockets[0]?.fail();
  vi.advanceTimersByTime(60_000);
  expect(sockets).toHaveLength(1);
});

it("does not replace an aged-out socket while the tab is hidden", () => {
  slot.warm(url, 10_000);
  sockets[0]?.open();
  visible = false;
  vi.advanceTimersByTime(WARM_SOCKET_TTL_MS);
  expect(sockets[0]?.closed).toHaveLength(1);
  expect(sockets).toHaveLength(1);
});

it("keeps one socket for one URL: another URL replaces it", () => {
  slot.warm(url);
  slot.warm(`${url}&other=1`);
  expect(sockets).toHaveLength(2);
  expect(sockets[0]?.closed).toHaveLength(1);
  expect(slot.adopt(url)).toBeUndefined();
});

it("scopes the keep window to its URL: a default call for another URL opens one socket, not a series", () => {
  slot.warm(url, 15_000);
  slot.warm(`${url}&other=1`);
  sockets[1]?.open();
  vi.advanceTimersByTime(60_000);
  expect(sockets).toHaveLength(2);
  expect(slot.state).toBe("empty");
});

it("stays empty when the page cannot open a socket", () => {
  const blocked = new WarmSocketSlot({ open: () => undefined, visible: () => true });
  blocked.warm(url, 10_000);
  expect(blocked.state).toBe("empty");
  const throwing = new WarmSocketSlot({
    open: () => {
      throw new Error("blocked");
    },
    visible: () => true,
  });
  throwing.warm(url);
  expect(throwing.state).toBe("empty");
});
