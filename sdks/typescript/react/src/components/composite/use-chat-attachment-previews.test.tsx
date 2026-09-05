/* @vitest-environment jsdom */

import type { ChatAttachment } from "@q9labsai/chalk-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useChatAttachmentPreviews } from "./use-chat-attachment-previews";

const attachment: ChatAttachment = { attachmentId: "attachment-1", fileName: "photo.png", mimeType: "image/png", byteLength: 42 };
let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
});

describe("useChatAttachmentPreviews", () => {
  it("shows a failed preview and retries URL resolution", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resolveUrl = vi.fn().mockRejectedValueOnce(new Error("signed URL unavailable")).mockResolvedValueOnce("https://files.example/photo.png");
    const container = document.createElement("div");
    const root = createRoot(container);
    cleanup = () => root.unmount();

    await act(async () => root.render(<PreviewProbe resolveUrl={resolveUrl} />));
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain("Preview could not be loaded");

    await act(async () => container.querySelector("button")?.click());
    await act(async () => Promise.resolve());

    expect(resolveUrl).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://files.example/photo.png");
  });
});

function PreviewProbe({ resolveUrl }: { readonly resolveUrl: (attachmentId: string) => Promise<string> }): React.JSX.Element {
  const previews = useChatAttachmentPreviews([attachment], resolveUrl);
  const url = previews.resolvedUrls.get(attachment.attachmentId);
  if (previews.failedAttachmentIds.has(attachment.attachmentId)) {
    return (
      <button type="button" onClick={() => previews.retry(attachment.attachmentId)}>
        Preview could not be loaded. Retry preview
      </button>
    );
  }
  return url ? <img alt="photo" src={url} /> : <span>Loading preview</span>;
}
