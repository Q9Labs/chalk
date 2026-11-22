import { afterEach, expect, test, vi } from "vitest";
import { createDefaultConnectionDependencies } from "./production";

afterEach(() => vi.unstubAllGlobals());

test.each([false, true])("only exposes whiteboard upload when the API reports availability=%s", async (available) => {
  vi.stubGlobal("fetch", async () => Response.json({ available }));
  const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test" });
  const filesChanged = Promise.withResolvers<void>();
  const board = dependencies.createWhiteboardClient?.({ token: async () => "sync-token", onSummary: () => {}, onFilesChanged: filesChanged.resolve });
  expect(board?.files.getDownloadUrl).toBeTypeOf("function");
  expect(board?.files.uploadFile).toBeUndefined();
  await filesChanged.promise;
  expect(typeof board?.files?.uploadFile === "function").toBe(available);
});
