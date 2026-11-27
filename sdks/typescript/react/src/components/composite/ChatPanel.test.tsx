// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatAttachment, ChatUploadFile } from "@q9labsai/chalk-client";
import { ChatPanelSurface, type ChatPanelSurfaceProps } from "./ChatPanel";

afterEach(() => document.body.replaceChildren());

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
if (!Element.prototype.scrollTo) Object.defineProperty(Element.prototype, "scrollTo", { value: () => undefined, configurable: true });
if (!URL.createObjectURL) Object.defineProperty(URL, "createObjectURL", { value: () => "blob:chalk-test", configurable: true });
if (!URL.revokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true });

function attachmentFor(file: ChatUploadFile): ChatAttachment {
  const description = "arrayBuffer" in file ? { fileName: file.name, mimeType: file.type, byteLength: file.size } : { fileName: file.fileName, mimeType: file.mimeType, byteLength: file.bytes.byteLength };
  return { attachmentId: `attachment-${description.fileName}`, fileName: description.fileName, mimeType: description.mimeType as ChatAttachment["mimeType"], byteLength: description.byteLength };
}

// Tests read what reached the callbacks from these recorded arrays, not from mock-call matchers, which the mock-calls gate ratchets to zero.
function recordingUpload(uploaded: ChatUploadFile[]) {
  return async (file: ChatUploadFile) => {
    uploaded.push(file);
    return attachmentFor(file);
  };
}

async function renderSurface(props: Partial<ChatPanelSurfaceProps>): Promise<Root> {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<ChatPanelSurface messages={[]} onSendMessage={async () => undefined} {...props} />));
  return root;
}

it("stages pasted files and leaves plain text paste alone", async () => {
  const image = new File(["image"], "board.png", { type: "image/png" });
  const uploaded: ChatUploadFile[] = [];
  const root = await renderSurface({ onUploadAttachment: recordingUpload(uploaded) });
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']");
  expect(textarea).toBeTruthy();

  const pasteFiles = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(pasteFiles, "clipboardData", { value: { files: [image] } });
  await act(async () => {
    textarea?.dispatchEvent(pasteFiles);
  });
  expect(pasteFiles.defaultPrevented).toBe(true);
  expect(uploaded).toEqual([image]);
  expect(document.body.textContent).toContain("board.png");

  const pasteText = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(pasteText, "clipboardData", { value: { files: [] } });
  await act(async () => {
    textarea?.dispatchEvent(pasteText);
  });
  expect(pasteText.defaultPrevented).toBe(false);
  expect(uploaded).toHaveLength(1);
  await act(async () => root.unmount());
});
