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

it("resolves a fresh source URL on every download click path and saves a blob", async () => {
  let calls = 0;
  const client = { chat: { files: { resolveUrl: async () => `signed-${++calls}` } } } as never;
  const before = window.location.href;
  const fetched: string[] = [];
  const payloads: string[] = [];
  const blobs = new Map<string, Blob>();
  const clicked: { readonly href: string; readonly download: string }[] = [];
  const originalClick = HTMLAnchorElement.prototype.click;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    fetched.push(String(url));
    const payload = `file-${fetched.length}`;
    payloads.push(payload);
    return new Response(payload, { status: 200 });
  });
  HTMLAnchorElement.prototype.click = function click() {
    clicked.push({ href: this.href, download: this.download });
  };
  URL.createObjectURL = (blob) => {
    const url = `blob:document-${blobs.size + 1}`;
    blobs.set(url, blob as Blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
  try {
    await downloadDocumentSource(client, manifest, "deck.pdf");
    await downloadDocumentSource(client, manifest, "deck.pdf");
  } finally {
    HTMLAnchorElement.prototype.click = originalClick;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.unstubAllGlobals();
  }
  expect(calls).toBe(2);
  expect(fetched).toEqual(["signed-1", "signed-2"]);
  expect(clicked).toHaveLength(2);
  expect(new Set(clicked.map((anchor) => anchor.href)).size).toBe(2);
  for (const [index, anchor] of clicked.entries()) {
    expect(anchor.download).toBe("deck.pdf");
    expect(anchor.href.startsWith("blob:document-")).toBe(true);
    await expect(blobs.get(anchor.href)?.text()).resolves.toBe(payloads[index]);
  }
  expect(window.location.href).toBe(before);
});
