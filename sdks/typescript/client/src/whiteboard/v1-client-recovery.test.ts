import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { WhiteboardV1ClientFrameSchema } from "../generated/whiteboard-v1";
import type { SyncSocket } from "../sync/types";
import { ChalkWhiteboardV1Client } from "./v1-client";
import type { ChalkWhiteboardSummary, ChalkWhiteboardV1FileTransport } from "./types";

const sceneId = "10000000-0000-4000-8000-000000000001";
const files: ChalkWhiteboardV1FileTransport = {
  initiateUpload: async () => ({ uploadId: "upload-1", method: "PUT", uploadUrl: "https://files.test/upload", headers: {}, expiresAt: "2026-08-23T00:00:00.000Z" }),
  finalizeUpload: async () => undefined,
  getDownloadUrl: async () => ({ downloadUrl: "https://files.test/download", expiresAt: "2026-08-23T00:00:00.000Z" }),
};

describe("ChalkWhiteboardV1Client recovery summaries", () => {
  it("publishes terminal failure after ready and can be started again without duplicate sockets", async () => {
    const sockets: TestSocket[] = [];
    const client = new ChalkWhiteboardV1Client({
      url: "ws://sync.test/v1/whiteboard",
      token: async () => "token",
      files,
      webSocket: {
        connect: () => {
          const socket = new TestSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    const summaries: ChalkWhiteboardSummary["status"][] = [];
    const unsubscribeSummary = client.subscribeSummary((summary) => summaries.push(summary.status));

    const startup = client.startSceneSubscription();
    await settle();
    sockets[0]?.open();
    await settle();
    sockets[0]?.receive(welcome());
    await settle();
    sockets[0]?.receive(snapshotPage(sockets[0]?.requestId()));
    await expect(startup).resolves.toBeUndefined();
    expect(summaries.at(-1)).toBe("ready");

    sockets[0]?.close(1009);
    expect(summaries.slice(-2)).toEqual(["recovering", "failed"]);

    const retry = client.startSceneSubscription();
    await settle();
    sockets[1]?.open();
    await settle();
    sockets[1]?.receive(welcome());
    await settle();
    sockets[1]?.receive(snapshotPage(sockets[1]?.requestId()));
    await expect(retry).resolves.toBeUndefined();
    expect(sockets).toHaveLength(2);
    expect(summaries.at(-1)).toBe("ready");

    unsubscribeSummary();
    await client.stopSceneSubscription();
  });
});

function welcome(): Record<string, unknown> {
  return {
    type: "welcome",
    protocol: "whiteboard-v1",
    participant_id: "20000000-0000-4000-8000-000000000001",
    participant_generation: 1,
    capabilities: ["drawWhiteboard"],
    participant_capabilities: ["drawWhiteboard"],
    scene_id: sceneId,
    revision: "1",
    can_draw: true,
    presenting: false,
  };
}

function snapshotPage(requestId: string | undefined): Record<string, unknown> {
  return {
    type: "snapshot_page",
    request_id: requestId ?? "request-0000000001",
    scene_id: sceneId,
    revision: "1",
    page: 0,
    page_count: 1,
    elements: [],
    app_state: null,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class TestSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.onclose?.({ code });
  }

  open(): void {
    this.onopen?.();
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  requestId(): string | undefined {
    const frame = this.sent.map((value) => Schema.decodeUnknownSync(WhiteboardV1ClientFrameSchema)(JSON.parse(value))).find((value) => value.type === "request_snapshot");
    return frame?.request_id;
  }
}
