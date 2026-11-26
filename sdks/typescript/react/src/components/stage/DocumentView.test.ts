// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { PresentingDocumentManifest } from "@q9labsai/chalk-client";
import { documentKeyTurnEvent, documentSourceAttachment, downloadDocumentSource } from "./DocumentView";

const manifest = { documentId: "doc", attachmentId: "source-attachment", fileName: "deck.pdf", status: "ready", pages: [] } as PresentingDocumentManifest;

it("uses the source attachment for a Document download", () => {
  expect(documentSourceAttachment(manifest)).toMatchObject({ attachmentId: "source-attachment", fileName: "deck.pdf" });
});

it("ignores document page keys from editable controls and handled events", () => {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  expect(documentKeyTurnEvent({ key: "ArrowRight", target: textarea, defaultPrevented: false })).toBe(false);
  expect(documentKeyTurnEvent({ key: "ArrowRight", target: document.body, defaultPrevented: true })).toBe(false);
  expect(documentKeyTurnEvent({ key: "ArrowRight", target: document.body, defaultPrevented: false })).toBe(true);
  textarea.remove();
});

it("resolves a fresh source URL on every download click path without navigating", async () => {
  let calls = 0;
  const client = { chat: { files: { resolveUrl: async () => `signed-${++calls}` } } } as never;
  const before = window.location.href;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Blob(["file"]), { status: 200 })),
  );
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:document"), revokeObjectURL: vi.fn() }));
  await downloadDocumentSource(client, manifest, "deck.pdf");
  await downloadDocumentSource(client, manifest, "deck.pdf");
  expect(calls).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(window.location.href).toBe(before);
  vi.unstubAllGlobals();
});
