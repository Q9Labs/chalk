import {
  createChalkWhiteboardV1FileDownloadTransport, type ChalkWhiteboardV1Event, type ChalkWhiteboardV1Transport, type ChalkWhiteboardV1UpdateInput, type SpaceClient,
} from "@q9labsai/chalk-client";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { saveNativeAnnotationToBoard } from "./save-to-board";
import type { ScreenAnnotationFrame } from "./model";

const fixtures = vi.hoisted(() => ({
  bytes: new Uint8Array([137, 80, 78, 71]),
  importId: "6fa459ea-ee8a-4ca4-894e-db77e160355e",
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  randomUUID: () => fixtures.importId,
  digest: (_algorithm: string, input: Uint8Array) => new Uint8Array(createHash("sha256").update(input).digest()).buffer,
}));

vi.mock("expo-file-system", () => ({
  File: class {
    readonly size = fixtures.bytes.byteLength;
    readonly exists = true;
    bytes() { return Promise.resolve(fixtures.bytes); }
  },
}));

it.each([true, false])("reconciles a lost finalize response without duplicating the upload or board update (screen still current: %s)", async (current) => {
  const frame: ScreenAnnotationFrame<string> = {
    image: "file:///retained.png",
    publicationId: "screen",
    size: { width: 1080, height: 2400 },
    nowMs: 1000,
    marks: [{
      author: { participant_id: "test-artist", display_name: "Test Artist", color: "#000000" },
      created_revision: 1,
      committed_at_ms: 1000,
      expires_at_ms: null,
      draft: { mark_id: "chalk-mark", shape: { kind: "pen", points: [{ x: 10, y: 10 }, { x: 20, y: 30 }] }, width: 30, color: "#000000", lifetime: "keep" },
    }],
  };
  const requests: string[] = [];
  let ready = false;
  const sha256 = createHash("sha256").update(fixtures.bytes).digest("hex");
  const fileId = `annotation-${fixtures.importId}`;
  const fetchImplementation: typeof fetch = async (request, init) => {
    const url = new URL(String(request));
    if (url.hostname === "objects.test") {
      requests.push("put");
      expect(init).toMatchObject({ method: "PUT", body: fixtures.bytes });
      return new Response(null, { status: 200 });
    }
    if (url.pathname === `/v1/whiteboard/scenes/board/files/${fileId}/upload`) {
      requests.push("upload");
      expect(JSON.parse(String(init?.body))).toEqual({ sha256, mimeType: "image/png", byteLength: fixtures.bytes.byteLength });
      return Response.json(ready ? { ready } : { ready, uploadUrl: "https://objects.test/png", headers: {} });
    }
    expect(url.pathname).toBe(`/v1/whiteboard/scenes/board/files/${fileId}/finalize`);
    requests.push("finalize");
    expect(JSON.parse(String(init?.body))).toEqual({ sha256 });
    ready = true;
    throw new TypeError("response lost after finalizing");
  };
  const submitUpdate = vi.fn(async (_input: ChalkWhiteboardV1UpdateInput) => ({ sceneId: "board", operationId: "result", revision: "1" }));
  const subscribe = (listener: (event: ChalkWhiteboardV1Event) => void) => {
    listener({ type: "snapshot", sceneId: "board", revision: "0", elements: [] } as ChalkWhiteboardV1Event);
    return () => {};
  };
  const transport = {
    files: createChalkWhiteboardV1FileDownloadTransport({ baseUrl: "https://api.test", token: async () => "test", fetch: fetchImplementation }),
    submitUpdate, subscribe,
  } as ChalkWhiteboardV1Transport;
  const space = {
    getSnapshot: () => ({ whiteboard: { engine: { sceneId: "board", status: "ready" }, access: { canDraw: true } } }),
    whiteboard: { transport: () => transport },
  } as SpaceClient;

  const save = saveNativeAnnotationToBoard({ space, transport }, frame, () => 0, () => !ready || current);
  if (!current) {
    await expect(save).rejects.toThrow("changed while saving");
    expect(submitUpdate).not.toHaveBeenCalled();
    expect(requests).toEqual(["upload", "put", "finalize"]);
    return;
  }
  await save;
  expect(requests).toEqual(["upload", "put", "finalize", "upload"]);
  expect(submitUpdate).toHaveBeenCalledTimes(1);
  const update = submitUpdate.mock.calls[0]?.[0];
  expect(update?.syncAll).toBe(false);
  expect(update?.elements.map(({ type }) => type)).toEqual(["image", "freedraw"]);
  expect(update?.elements[0]?.payload.fileId).toBe(fileId);
});
