import { describe, expect, it } from "vitest";
import { V3SyncClient } from "./v3-client";
import { createV3SyncClient } from "./v3-create";
import { InMemoryV3PendingTargetStore } from "./v3-persistence";
import type { SyncSocket } from "./types";

describe("createV3SyncClient", () => {
  it("uses injected lifecycle, persistence, and websocket boundaries", async () => {
    const socket = new TestSocket();
    const connections: string[] = [];
    let subscribed = 0;
    let unsubscribed = 0;
    const client = createV3SyncClient({
      url: "wss://sync.test/v3/sync",
      token: async () => "token",
      pendingStore: new InMemoryV3PendingTargetStore(),
      webSocket: {
        connect(url) {
          connections.push(url);
          return socket;
        },
      },
      lifecycle: {
        subscribe() {
          subscribed += 1;
          return () => {
            unsubscribed += 1;
          };
        },
      },
    });

    expect(client).toBeInstanceOf(V3SyncClient);
    expect(client.getSnapshot().connection.phase).toBe("idle");

    await client.start();
    expect(connections).toEqual(["wss://sync.test/v3/sync"]);
    expect(subscribed).toBe(1);

    client.stop();
    expect(unsubscribed).toBe(1);
    expect(socket.closed).toEqual([1000, "client stopped"]);
  });
});

class TestSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed: [number | undefined, string | undefined] | undefined;

  send(): void {}

  close(code?: number, reason?: string): void {
    this.closed = [code, reason];
  }
}
