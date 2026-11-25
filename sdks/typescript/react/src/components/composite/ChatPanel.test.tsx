// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatAttachment, ChatUploadFile } from "@q9labsai/chalk-client";
import { ChatPanelSurface, type ChatPanelSurfaceProps } from "./ChatPanel";

afterEach(() => document.body.replaceChildren());

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
if (!Element.prototype.scrollTo) Object.defineProperty(Element.prototype, "scrollTo", { value: () => undefined, configurable: true });

function attachmentFor(file: ChatUploadFile): ChatAttachment {
  const description = "arrayBuffer" in file ? { fileName: file.name, mimeType: file.type, byteLength: file.size } : { fileName: file.fileName, mimeType: file.mimeType, byteLength: file.bytes.byteLength };
  return { attachmentId: `attachment-${description.fileName}`, fileName: description.fileName, mimeType: description.mimeType as ChatAttachment["mimeType"], byteLength: description.byteLength };
}

async function renderSurface(props: Partial<ChatPanelSurfaceProps>): Promise<Root> {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<ChatPanelSurface messages={[]} onSendMessage={async () => undefined} {...props} />));
  return root;
}

async function rerenderSurface(root: Root, props: Partial<ChatPanelSurfaceProps>) {
  await act(async () => root.render(<ChatPanelSurface messages={[]} onSendMessage={async () => undefined} {...props} />));
}

it("stages files handed to the composer by a call drop once and starts their upload", async () => {
  const pdf = new File(["pdf"], "Algebra worksheet.pdf", { type: "application/pdf" });
  const upload = vi.fn(async (file: ChatUploadFile) => attachmentFor(file));
  const consumed = vi.fn();
  const fileDrop = { files: [pdf] };
  const root = await renderSurface({ onUploadAttachment: upload, fileDrop, onFileDropStaged: consumed });

  expect(upload).toHaveBeenCalledWith(pdf);
  expect(consumed).toHaveBeenCalledWith(fileDrop);
  expect(document.body.textContent).toContain("Algebra worksheet.pdf");
  expect(document.body.textContent).toContain("Ready");

  await rerenderSurface(root, { onUploadAttachment: upload, fileDrop, onFileDropStaged: consumed });
  expect(upload).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it("uses the paperclip validation for dropped files", async () => {
  const zip = new File(["zip"], "archive.zip", { type: "application/zip" });
  const upload = vi.fn(async (file: ChatUploadFile) => attachmentFor(file));
  const pickChatFiles = vi.fn(async () => [zip]);
  const root = await renderSurface({ onUploadAttachment: upload, pickChatFiles });

  await act(async () => document.querySelector<HTMLButtonElement>("[aria-label='Attach files']")?.click());
  const paperclipError = document.querySelector("[role=alert]")?.textContent;
  expect(paperclipError).toBe("archive.zip is not a supported chat attachment.");
  expect(upload).not.toHaveBeenCalled();

  await rerenderSurface(root, { onUploadAttachment: upload, pickChatFiles, fileDrop: { files: [zip] } });
  expect(document.querySelector("[role=alert]")?.textContent).toBe(paperclipError);
  expect(upload).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("stages pasted files and leaves plain text paste alone", async () => {
  const image = new File(["image"], "board.png", { type: "image/png" });
  const upload = vi.fn(async (file: ChatUploadFile) => attachmentFor(file));
  const root = await renderSurface({ onUploadAttachment: upload });
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']");
  expect(textarea).toBeTruthy();

  const pasteFiles = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(pasteFiles, "clipboardData", { value: { files: [image] } });
  await act(async () => {
    textarea?.dispatchEvent(pasteFiles);
  });
  expect(pasteFiles.defaultPrevented).toBe(true);
  expect(upload).toHaveBeenCalledWith(image);
  expect(document.body.textContent).toContain("board.png");

  const pasteText = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(pasteText, "clipboardData", { value: { files: [] } });
  await act(async () => {
    textarea?.dispatchEvent(pasteText);
  });
  expect(pasteText.defaultPrevented).toBe(false);
  expect(upload).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
