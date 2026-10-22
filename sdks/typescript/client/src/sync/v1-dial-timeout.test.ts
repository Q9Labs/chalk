import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { expect, it, vi } from "vitest";
import { createBrowserWebSocketFactory } from "./browser";
import { V1SyncClient } from "./v1-client";
import type { SyncSocket } from "./types";

it("retries a TCP connection that never completes its WebSocket handshake", async () => {
  const sockets = new Set<Duplex>();
  let attempts = 0;
  const server = createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    attempts++;
    if (attempts === 1) return; // Accept TCP and the request, but never send HTTP 101.
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP test server has no port");
  const clock = new DialClock();
  const token = vi.fn(async () => "test-token");
  const client = new V1SyncClient({ url: `ws://127.0.0.1:${address.port}/v1/sync`, token, webSocket: createBrowserWebSocketFactory(), clock, reconnectDelayMs: 250 });
  try {
    await client.start();
    await vi.waitFor(() => expect(attempts).toBe(1));
    clock.advance(9_999);
    expect(token).not.toHaveBeenCalled();
    clock.advance(1);
    clock.advance(250); // Existing first retry backoff.
    await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 1_000 });
    await vi.waitFor(() => expect(token).toHaveBeenCalledTimes(1));
    expect(client.getSnapshot().connection.phase).toBe("recovering");
    clock.advance(20_000);
    expect(attempts).toBe(2);
  } finally {
    client.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

it("accepts a slow upgrade before the deadline and cancels the timer on stop", async () => {
  const clock = new DialClock();
  const socket = testSocket();
  const token = vi.fn(async () => "test-token");
  const client = new V1SyncClient({ url: "ws://fixture.test/v1/sync", token, webSocket: { connect: () => socket }, clock });
  try {
    await client.start();
    clock.advance(9_999);
    socket.onopen?.();
    await Promise.resolve();
    clock.advance(20_000);
    expect(socket.close).not.toHaveBeenCalled();
    expect(client.getSnapshot().connection.phase).toBe("recovering");
  } finally {
    client.stop();
  }
  const pendingSocket = testSocket();
  const stopped = new V1SyncClient({ url: "ws://fixture.test/v1/sync", token, webSocket: { connect: () => pendingSocket }, clock });
  await stopped.start();
  stopped.stop();
  clock.advance(20_000);
  expect(pendingSocket.close).toHaveBeenCalledTimes(1);
});

it("ignores a timed-out attempt's late open without cancelling the replacement deadline", async () => {
  const clock = new DialClock();
  const first = testSocket();
  const second = testSocket();
  const connect = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
  const token = vi.fn(async () => "test-token");
  const client = new V1SyncClient({ url: "ws://fixture.test/v1/sync", token, webSocket: { connect }, clock, reconnectDelayMs: 250 });
  try {
    await client.start();
    clock.advance(10_250);
    expect(connect).toHaveBeenCalledTimes(2);
    first.onopen?.();
    await Promise.resolve();
    expect(token).not.toHaveBeenCalled();
    clock.advance(10_000);
    expect(second.close).toHaveBeenCalledTimes(1);
  } finally {
    client.stop();
  }
});

function testSocket(): SyncSocket {
  return { onopen: null, onmessage: null, onclose: null, onerror: null, send: vi.fn(), close: vi.fn() };
}

class DialClock {
  #now = 0;
  #nextHandle = 0;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();
  now(): number {
    return this.#now;
  }
  setTimeout(callback: () => void, milliseconds: number): number {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, { at: this.#now + milliseconds, callback });
    return handle;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#timers.delete(handle);
  }
  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    while (true) {
      const due = [...this.#timers].filter(([, timer]) => timer.at <= target).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.#timers.delete(handle);
      this.#now = timer.at;
      timer.callback();
    }
    this.#now = target;
  }
}
