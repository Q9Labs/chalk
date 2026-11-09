import { afterEach, expect, it, vi } from "vitest";
import { V1SyncClient } from "./v1-client";
import { createDirectFirstWebSocketFactory, createDirectPathMemory } from "./direct-first";
import type { SyncSocket, SyncWebSocketFactory } from "./types";
class Socket implements SyncSocket {
  onopen: SyncSocket["onopen"] = null;
  onmessage: SyncSocket["onmessage"] = null;
  onerror: SyncSocket["onerror"] = null;
  onclose: SyncSocket["onclose"] = null;
  frames: string[] = [];
  send(data: string) {
    this.frames.push(data);
  }
  close() {
    queueMicrotask(() => this.onclose?.({ code: 1006, wasClean: false }));
  }
}
afterEach(() => vi.useRealTimers());
for (const wrapped of [false, true]) {
  it(`retries a transient token failure after open (directFirst=${wrapped})`, async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const inner: SyncWebSocketFactory = {
      connect: () => {
        const s = new Socket();
        sockets.push(s);
        return s;
      },
    };
    const factory = wrapped ? createDirectFirstWebSocketFactory({ directUrl: "wss://direct.example.test/v1/sync", inner, memory: createDirectPathMemory() }) : inner;
    const client = new V1SyncClient({
      url: "wss://tunnel.example.test/v1/sync",
      token: async () => {
        throw new Error("temporary refresh failure");
      },
      webSocket: factory,
      reconnectDelayMs: 250,
    });
    try {
      await client.start();
      sockets[0]!.onopen?.();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sockets.length).toBeGreaterThan(1);
    } finally {
      client.stop();
    }
  });
}
for (const wrapped of [false, true]) {
  it(`retries a transport error after open before welcome (directFirst=${wrapped})`, async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const inner: SyncWebSocketFactory = {
      connect: () => {
        const s = new Socket();
        sockets.push(s);
        return s;
      },
    };
    const factory = wrapped ? createDirectFirstWebSocketFactory({ directUrl: "wss://direct.example.test/v1/sync", inner, memory: createDirectPathMemory() }) : inner;
    const client = new V1SyncClient({ url: "wss://tunnel.example.test/v1/sync", token: async () => "test-token", webSocket: factory, reconnectDelayMs: 250 });
    try {
      await client.start();
      sockets[0]!.onopen?.();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.onerror?.();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sockets.length).toBeGreaterThan(1);
    } finally {
      client.stop();
    }
  });
}
it("never sends the token over a plain direct URL when the Tunnel URL is secure", async () => {
  const urls: string[] = [];
  const sockets: Socket[] = [];
  const inner: SyncWebSocketFactory = {
    connect: (url) => {
      urls.push(url);
      const s = new Socket();
      sockets.push(s);
      return s;
    },
  };
  const factory = createDirectFirstWebSocketFactory({ directUrl: "ws://direct.example.test/v1/sync", inner, memory: createDirectPathMemory() });
  const client = new V1SyncClient({ url: "wss://tunnel.example.test/v1/sync", token: async () => "dummy-review-token", webSocket: factory });
  try {
    await client.start();
    sockets[0]!.onopen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(urls.map((url) => new URL(url).origin)).toEqual(["wss://tunnel.example.test"]);
    expect(JSON.parse(sockets[0]!.frames[0]!).token).toBe("dummy-review-token");
  } finally {
    client.stop();
  }
});
it("uses the healthy Tunnel after repeated direct closes before any server frame", async () => {
  vi.useFakeTimers();
  const urls: string[] = [];
  const sockets: Socket[] = [];
  const inner: SyncWebSocketFactory = {
    connect: (url) => {
      urls.push(url);
      const s = new Socket();
      sockets.push(s);
      return s;
    },
  };
  const factory = createDirectFirstWebSocketFactory({ directUrl: "wss://direct.example.test/v1/sync", inner, memory: createDirectPathMemory() });
  const client = new V1SyncClient({ url: "wss://tunnel.example.test/v1/sync", token: async () => "dummy-review-token", webSocket: factory, reconnectDelayMs: 250 });
  try {
    await client.start();
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = sockets.at(-1)!;
      current.onopen?.();
      await vi.advanceTimersByTimeAsync(0);
      current.onclose?.({ code: 1006, wasClean: false });
      await vi.advanceTimersByTimeAsync(250 * 2 ** attempt);
    }
    expect(urls.some((url) => new URL(url).host === "tunnel.example.test")).toBe(true);
  } finally {
    client.stop();
  }
});
