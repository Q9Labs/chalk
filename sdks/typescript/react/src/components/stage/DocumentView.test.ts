// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { PresentingDocumentManifest } from "@q9labsai/chalk-client";
import { documentKeyTurnEvent, documentSourceAttachment } from "./DocumentView";

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
