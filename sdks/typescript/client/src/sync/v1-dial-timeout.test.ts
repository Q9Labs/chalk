import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { expect, it, vi } from "vitest";
import { createBrowserWebSocketFactory } from "./browser";
import { V1SyncClient } from "./v1-client";
import type { SyncSocket, SyncWebSocketFactory } from "./types";
import { ManualClock } from "../../tests/helpers/manual-clock";
import { ChalkWhiteboardV1Client } from "../whiteboard/v1-client";

it.each([
  ["sync", 10_000],
  ["whiteboard", 10_000],
  ["sync", 30_000],
  ["whiteboard", 30_000],
] as const)("%s retries a TCP-stalled handshake after %i ms and admits a slow replacement", async (kind, allowance) => {
  let attempts = 0;
  const clock = new ManualClock();
  const server = await upgradeServer((request, socket) => {
    attempts++;
    if (attempts === 1) return; // Accept TCP and the request, but never send HTTP 101.
    clock.setTimeout(() => acceptUpgrade(request, socket), 8_000);
  });
  const token = vi.fn(async () => "test-token");
  const options = { url: server.url(kind), token, webSocket: createBrowserWebSocketFactory(), clock, reconnectDelayMs: 250, ...(allowance > 10_000 ? { dialTimeoutMs: allowance } : {}) };
  const client = dialClient(kind, options);
  try {
    await client.start();
    await vi.waitFor(() => expect(attempts).toBe(1));
    clock.advance(allowance - 1);
    expect(token).not.toHaveBeenCalled();
    clock.advance(1);
    clock.advance(250); // Existing first retry backoff.
    await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 1_000 });
    clock.advance(7_999);
    expect(token).not.toHaveBeenCalled();
    clock.advance(1);
    await vi.waitFor(() => expect(token).toHaveBeenCalledTimes(1));
    // The lifecycle preserves a recovering transport for 60 seconds across its
    // shorter foreground/background cycles: 18.25s here, or 38.25s for Native.
    expect(clock.now()).toBe(allowance + 250 + 8_000);
    expect(clock.now()).toBeLessThan(60_000);
    expect(client.phase()).toBe("recovering");
    expect(client.timeoutEvidence()).toBeTruthy();
    clock.advance(60_000);
    expect(attempts).toBe(2);
  } finally {
    await client.stop();
    await server.close();
  }
});

it.each([
  ["sync", 3_200],
  ["whiteboard", 3_200],
  ["sync", 8_000],
  ["whiteboard", 8_000],
] as const)(
  "%s accepts a real upgrade delayed by %i ms on its first attempt",
  async (kind, delayMs) => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let attempts = 0;
    const server = await upgradeServer((request, socket) => {
      attempts++;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!socket.destroyed) acceptUpgrade(request, socket);
      }, delayMs);
      timers.add(timer);
    });
    const token = vi.fn(async () => "test-token");
    const client = dialClient(kind, { url: server.url(kind), token, webSocket: createBrowserWebSocketFactory(), reconnectDelayMs: 250 });
    try {
      await client.start();
      await vi.waitFor(() => expect(token).toHaveBeenCalledTimes(1), { timeout: delayMs + 1_000 });
      expect(attempts).toBe(1);
      expect(client.timeoutEvidence()).toBeFalsy();
    } finally {
      await client.stop();
      for (const timer of timers) clearTimeout(timer);
      await server.close();
    }
  },
  12_000,
);

it("accepts a slow upgrade before the deadline and cancels the timer on stop", async () => {
  const clock = new ManualClock();
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
  const clock = new ManualClock();
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

/** A real TCP server that hands each WebSocket upgrade to the test and destroys its sockets on close. */
async function upgradeServer(onUpgrade: (request: IncomingMessage, socket: Duplex) => void) {
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", onUpgrade);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP test server has no port");
  return {
    url: (kind: "sync" | "whiteboard") => `ws://127.0.0.1:${address.port}/v1/${kind}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function acceptUpgrade(request: IncomingMessage, socket: Duplex): void {
  const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
}

function testSocket(): SyncSocket {
  return { onopen: null, onmessage: null, onclose: null, onerror: null, send: vi.fn(), close: vi.fn() };
}

function dialClient(kind: "sync" | "whiteboard", options: { url: string; token: () => Promise<string>; webSocket: SyncWebSocketFactory; clock?: ManualClock; reconnectDelayMs: number; dialTimeoutMs?: number }) {
  if (kind === "sync") {
    const client = new V1SyncClient(options);
    return { start: () => client.start(), stop: () => client.stop(), phase: () => client.getSnapshot().connection.phase, timeoutEvidence: () => client.getSnapshot().connection.dialTimeoutCount };
  }
  let timedOut = false;
  let phase = "unsubscribed";
  const client = new ChalkWhiteboardV1Client({
    ...options,
    files: { getDownloadUrl: async () => ({ downloadUrl: "https://files.test/download", expiresAt: "2026-08-23T00:00:00.000Z" }) },
    onSummary: (summary) => {
      phase = summary.status;
      if (summary.error?.message.includes("timed out before opening")) timedOut = true;
    },
  });
  let startup: Promise<unknown> | undefined;
  return {
    start: async () => {
      startup = client.startSceneSubscription().catch(() => undefined);
      await Promise.resolve();
    },
    stop: async () => {
      await client.stopSceneSubscription();
      await startup;
    },
    phase: () => phase,
    timeoutEvidence: () => timedOut,
  };
}
