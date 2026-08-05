import { describe, expect, it, vi } from "vitest";

import { decodeEmbeddedWhiteboardHostMessage, encodeEmbeddedWhiteboardMessage, type ChalkEmbeddedWhiteboardRendererMessage } from "./protocol";
import { ChalkWhiteboardController, type ChalkEmbeddedWhiteboardRendererPort, type ChalkEmbeddedWhiteboardTransport, type ChalkEmbeddedWhiteboardTransportEvent } from "./controller";

const rendererGeneration = "renderer-generation-1";
const journeyId = "journey-1";

describe("ChalkWhiteboardController", () => {
  it("handshakes, starts the canonical transport, and maps snapshots without credentials", async () => {
    const renderer = rendererPort();
    const transport = transportFixture();
    const controller = new ChalkWhiteboardController({
      renderer,
      transport,
      journeyId,
      canDraw: true,
      canClear: false,
      nextMessageId: sequentialIds("host"),
    });

    controller.start();
    renderer.receive(rendererMessage({ type: "ready", payload: { excalidrawVersion: "0.18.1", supportedBridgeVersions: [1] } }));

    await vi.waitFor(() => expect(transport.startSceneSubscription).toHaveBeenCalledOnce());
    expect(hostMessages(renderer).at(0)).toMatchObject({
      type: "initialize",
      payload: { canDraw: true, canClear: false, theme: "light" },
    });

    transport.emit({
      type: "snapshot",
      sceneId: "10000000-0000-4000-8000-000000000001",
      revision: "7",
      elements: [transportElement("rectangle-1")],
    });

    const snapshot = hostMessages(renderer).at(-1);
    expect(snapshot).toMatchObject({
      type: "apply_snapshot",
      payload: {
        revision: "7",
        elements: [{ id: "rectangle-1", version_nonce: 2, is_deleted: false }],
      },
    });
    expect(renderer.sent.join(" ")).not.toContain("token");
    expect(renderer.sent.join(" ")).not.toContain("uploadUrl");

    transport.emit({
      type: "cursor",
      participantId: "participant-1",
      displayName: "Grace",
      x: 24,
      y: 48,
      occurredAt: "2026-08-04T08:00:00.000Z",
    });
    const cursor = hostMessages(renderer).at(-1);
    if (!cursor || cursor.type !== "apply_cursor") throw new Error("expected a renderer cursor");
    expect(cursor.payload).toEqual({ type: "cursor", participantId: "participant-1", displayName: "Grace", x: 24, y: 48, occurredAt: "2026-08-04T08:00:00.000Z" });

    controller.stop();
    expect(transport.stopSceneSubscription).toHaveBeenCalledOnce();
  });

  it("submits renderer changes through one operation result and rejects clear without capability", async () => {
    const renderer = rendererPort();
    const transport = transportFixture();
    const controller = new ChalkWhiteboardController({
      renderer,
      transport,
      journeyId,
      canDraw: true,
      canClear: false,
      nextMessageId: sequentialIds("host"),
    });
    controller.start();
    renderer.receive(rendererMessage({ type: "ready", payload: { excalidrawVersion: "0.18.1", supportedBridgeVersions: [1] } }));
    await vi.waitFor(() => expect(transport.startSceneSubscription).toHaveBeenCalledOnce());
    transport.emit({
      type: "snapshot",
      sceneId: "10000000-0000-4000-8000-000000000001",
      revision: "7",
      elements: [],
    });
    const snapshot = hostMessages(renderer).find((message) => message.type === "apply_snapshot");
    if (!snapshot || snapshot.type !== "apply_snapshot") throw new Error("expected a renderer snapshot");

    const updateMessage = rendererMessage({
      type: "local_update",
      payload: {
        requestId: "request-update-1",
        sceneId: "10000000-0000-4000-8000-000000000001",
        sceneGeneration: snapshot.payload.sceneGeneration,
        syncAll: false,
        elements: [
          {
            id: "rectangle-1",
            type: "rectangle",
            version: 1,
            version_nonce: 2,
            index: "a0",
            is_deleted: false,
            payload: {},
          },
        ],
      },
    });
    renderer.receive(updateMessage);
    renderer.receive(updateMessage);

    await vi.waitFor(() => expect(transport.submitUpdate).toHaveBeenCalledOnce());
    expect(transport.submitUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: [expect.objectContaining({ id: "rectangle-1", versionNonce: 2, isDeleted: false })],
      }),
    );
    await vi.waitFor(() => expect(hostMessages(renderer).some((message) => message.type === "operation_result" && message.payload.requestId === "request-update-1" && message.payload.ok)).toBe(true));

    transport.emit({
      type: "snapshot",
      sceneId: "10000000-0000-4000-8000-000000000001",
      revision: "9",
      elements: [],
    });
    renderer.receive(
      rendererMessage({
        type: "local_update",
        payload: {
          requestId: "request-stale-1",
          sceneId: "10000000-0000-4000-8000-000000000001",
          sceneGeneration: snapshot.payload.sceneGeneration,
          syncAll: false,
          elements: [],
        },
      }),
    );
    await vi.waitFor(() => expect(hostMessages(renderer).some((message) => message.type === "operation_result" && message.payload.requestId === "request-stale-1" && !message.payload.ok)).toBe(true));
    expect(transport.submitUpdate).toHaveBeenCalledOnce();

    renderer.receive(rendererMessage({ type: "clear", payload: { requestId: "request-clear-1" } }));
    await vi.waitFor(() => expect(hostMessages(renderer).some((message) => message.type === "operation_result" && message.payload.requestId === "request-clear-1" && !message.payload.ok)).toBe(true));
    expect(transport.clear).not.toHaveBeenCalled();
  });

  it("opens newer required element types read-only without rewriting them", async () => {
    const renderer = rendererPort();
    const transport = transportFixture();
    const onError = vi.fn();
    const onCompatibilityChange = vi.fn();
    const controller = new ChalkWhiteboardController({
      renderer,
      transport,
      journeyId,
      canDraw: true,
      canClear: true,
      onError,
      onCompatibilityChange,
      nextMessageId: sequentialIds("host"),
    });
    controller.start();
    renderer.receive(rendererMessage({ type: "ready", payload: { excalidrawVersion: "0.18.1", supportedBridgeVersions: [1] } }));
    await vi.waitFor(() => expect(transport.startSceneSubscription).toHaveBeenCalledOnce());

    transport.emit({
      type: "snapshot",
      sceneId: "10000000-0000-4000-8000-000000000001",
      revision: "7",
      elements: [{ ...transportElement("future-1"), type: "future-required-widget" }],
    });

    expect(hostMessages(renderer)).toContainEqual(
      expect.objectContaining({
        type: "set_capabilities",
        payload: { canDraw: false, canClear: false },
      }),
    );
    expect(onCompatibilityChange).toHaveBeenCalledWith(expect.objectContaining({ compatible: false, message: expect.stringContaining("Update required") }));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "update_required", recoverable: false }));
    expect(transport.submitUpdate).not.toHaveBeenCalled();
  });

  it("validates image signatures, dimensions, and digests before native upload", async () => {
    const renderer = rendererPort();
    const transport = transportFixture();
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchImplementation: typeof globalThis.fetch = vi.fn(async (input, init) => {
      if (String(input).startsWith("data:")) return realFetch(input, init);
      return new Response(null, { status: 200 });
    });
    vi.mocked(transport.files.initiateUpload).mockResolvedValue({
      uploadId: "upload-1",
      method: "PUT",
      uploadUrl: "https://storage.test/upload-1",
      headers: { "content-type": "image/png" },
    });
    vi.mocked(transport.files.finalizeUpload).mockResolvedValue(undefined);
    const controller = new ChalkWhiteboardController({
      renderer,
      transport,
      journeyId,
      canDraw: true,
      canClear: true,
      fetch: fetchImplementation,
      nextMessageId: sequentialIds("host"),
    });
    controller.start();
    renderer.receive(rendererMessage({ type: "ready", payload: { excalidrawVersion: "0.18.1", supportedBridgeVersions: [1] } }));
    await vi.waitFor(() => expect(transport.startSceneSubscription).toHaveBeenCalledOnce());
    transport.emit({
      type: "snapshot",
      sceneId: "10000000-0000-4000-8000-000000000001",
      revision: "7",
      elements: [],
    });

    const dataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    renderer.receive(
      rendererMessage({
        type: "file_write",
        payload: {
          requestId: "request-file-1",
          fileId: "file-1",
          mimeType: "image/png",
          byteLength: 68,
          sha256: "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
          dataURL,
        },
      }),
    );
    await vi.waitFor(() => expect(transport.files.finalizeUpload).toHaveBeenCalledWith("upload-1"));

    renderer.receive(
      rendererMessage({
        type: "file_write",
        payload: {
          requestId: "request-file-tampered",
          fileId: "file-2",
          mimeType: "image/png",
          byteLength: 68,
          sha256: "0".repeat(64),
          dataURL,
        },
      }),
    );
    await vi.waitFor(() => expect(hostMessages(renderer).some((message) => message.type === "operation_result" && message.payload.requestId === "request-file-tampered" && !message.payload.ok)).toBe(true));

    renderer.receive(
      rendererMessage({
        type: "file_write",
        payload: {
          requestId: "request-file-mime-mismatch",
          fileId: "file-3",
          mimeType: "image/png",
          byteLength: 68,
          sha256: "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
          dataURL: dataURL.replace("data:image/png", "data:image/jpeg"),
        },
      }),
    );
    await vi.waitFor(() => expect(hostMessages(renderer).some((message) => message.type === "operation_result" && message.payload.requestId === "request-file-mime-mismatch" && !message.payload.ok)).toBe(true));
    expect(transport.files.initiateUpload).toHaveBeenCalledOnce();
    expect(renderer.sent.join(" ")).not.toContain("https://storage.test/upload-1");
  });

  it("requires a bounded, identity-encoded response before buffering native downloads", async () => {
    vi.stubGlobal("FileReader", TestFileReader);
    const renderer = rendererPort();
    const transport = transportFixture();
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
    const fetchImplementation: typeof globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(png, { headers: { "content-type": "image/png" } }))
      .mockResolvedValueOnce(
        new Response(png, {
          headers: {
            "content-encoding": "gzip",
            "content-length": String(png.byteLength),
            "content-type": "image/png",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(png, {
          headers: {
            "content-length": String(png.byteLength),
            "content-type": "image/png",
          },
        }),
      );
    vi.mocked(transport.files.getDownloadUrl).mockImplementation(async (fileId) => ({
      downloadUrl: `https://storage.test/${fileId}`,
    }));
    const controller = new ChalkWhiteboardController({
      renderer,
      transport,
      journeyId,
      canDraw: true,
      canClear: true,
      fetch: fetchImplementation,
      nextMessageId: sequentialIds("host"),
    });
    controller.start();
    renderer.receive(rendererMessage({ type: "ready", payload: { excalidrawVersion: "0.18.1", supportedBridgeVersions: [1] } }));
    await vi.waitFor(() => expect(transport.startSceneSubscription).toHaveBeenCalledOnce());

    renderer.receive(rendererMessage({ type: "file_read", payload: { requestId: "request-file-no-length", fileId: "file-no-length" } }));
    await vi.waitFor(() => expect(hostMessages(renderer).some((message) => message.type === "operation_result" && message.payload.requestId === "request-file-no-length" && !message.payload.ok)).toBe(true));

    renderer.receive(rendererMessage({ type: "file_read", payload: { requestId: "request-file-encoded", fileId: "file-encoded" } }));
    await vi.waitFor(() => expect(hostMessages(renderer).some((message) => message.type === "operation_result" && message.payload.requestId === "request-file-encoded" && !message.payload.ok)).toBe(true));

    renderer.receive(rendererMessage({ type: "file_read", payload: { requestId: "request-file-valid", fileId: "file-valid" } }));
    await vi.waitFor(() => expect(hostMessages(renderer).some((message) => message.type === "provide_file_bytes" && message.payload.requestId === "request-file-valid" && message.payload.mimeType === "image/png")).toBe(true));
  });
});

function rendererPort(): ChalkEmbeddedWhiteboardRendererPort & { sent: string[]; receive: (message: string) => void } {
  const listeners = new Set<(message: string) => void>();
  return {
    sent: [],
    postMessage(message) {
      this.sent.push(message);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    receive(message) {
      listeners.forEach((listener) => listener(message));
    },
  };
}

function transportFixture(): ChalkEmbeddedWhiteboardTransport & { emit: (event: ChalkEmbeddedWhiteboardTransportEvent) => void } {
  const listeners = new Set<(event: ChalkEmbeddedWhiteboardTransportEvent) => void>();
  return {
    startSceneSubscription: vi.fn().mockResolvedValue(undefined),
    stopSceneSubscription: vi.fn(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submitUpdate: vi.fn().mockResolvedValue({
      operationId: "operation-0000000001",
      sceneId: "10000000-0000-4000-8000-000000000001",
      revision: "8",
    }),
    sendCursor: vi.fn(),
    requestSnapshot: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn(),
    files: {
      initiateUpload: vi.fn(),
      finalizeUpload: vi.fn(),
      getDownloadUrl: vi.fn(),
    },
    emit(event) {
      listeners.forEach((listener) => listener(event));
    },
  };
}

function rendererMessage(message: ChalkEmbeddedWhiteboardRendererMessage): string {
  return encodeEmbeddedWhiteboardMessage(message, {
    rendererGeneration,
    journeyId,
    nextMessageId: () => `renderer-${++rendererMessageSequence}`,
  });
}

let rendererMessageSequence = 0;

function hostMessages(renderer: ReturnType<typeof rendererPort>) {
  return renderer.sent.map((message) => decodeEmbeddedWhiteboardHostMessage(message, rendererGeneration));
}

function sequentialIds(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function transportElement(id: string) {
  return {
    id,
    type: "rectangle",
    version: 1,
    versionNonce: 2,
    index: "a0",
    isDeleted: false,
    payload: {},
  };
}

class TestFileReader {
  result: string | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;

  readAsDataURL(blob: Blob): void {
    void blob
      .arrayBuffer()
      .then((buffer) => {
        const binary = String.fromCharCode(...new Uint8Array(buffer));
        this.result = `data:${blob.type};base64,${btoa(binary)}`;
        this.onload?.();
      })
      .catch(() => this.onerror?.());
  }
}
