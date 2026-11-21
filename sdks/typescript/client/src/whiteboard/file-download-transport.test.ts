import { expect, test, vi } from "vitest";
import { createChalkWhiteboardV1FileDownloadTransport } from "./file-download-transport";

test("reconciles a lost PUT, and retries a lost finalize response without sending bytes again", async () => {
  const digest = "a".repeat(64);
  const input = { sceneId: "scene", fileId: "a/frame", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", sha256: digest };
  let ready = false;
  let puts = 0;
  const fetchImplementation = vi.fn<typeof globalThis.fetch>(async (request, init) => {
    const url = new URL(String(request));
    const headers = new Headers(init?.headers);
    if (url.hostname === "objects.test") {
      expect(init).toMatchObject({ method: "PUT", credentials: "omit", redirect: "error", body: input.bytes });
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("if-none-match")).toBe("*");
      puts++;
      throw new TypeError("PUT response was lost");
    }

    expect(headers.get("authorization")).toBe("Bearer sync-token");
    const prefix = "/v1/whiteboard/scenes/scene/files/a%2Fframe/";
    if (url.pathname === prefix + "upload") {
      expect(init?.body).toBe(JSON.stringify({ mimeType: "image/png", byteLength: 3, sha256: digest }));
      return Response.json(ready ? { ready } : { ready, uploadUrl: "https://objects.test/signed", headers: { "if-none-match": "*" } });
    }
    expect(url.pathname).toBe(prefix + "finalize");
    expect(init?.body).toBe(JSON.stringify({ sha256: digest }));
    ready = true;
    throw new TypeError("Finalize response was lost");
  });
  const files = createChalkWhiteboardV1FileDownloadTransport({ baseUrl: "https://api.test", token: async () => "sync-token", fetch: fetchImplementation });
  expect(files.uploadFile).toBeDefined();
  await expect(files.uploadFile?.(input)).rejects.toMatchObject({ operation: "upload_file", recoverable: true });
  await expect(files.uploadFile?.(input)).resolves.toBeUndefined();
  expect(puts).toBe(1);
  expect(fetchImplementation).toHaveBeenCalledTimes(4);
});
