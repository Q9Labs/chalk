// @vitest-environment happy-dom

import type { ChatMessage, ChatUploadFile } from "@q9labsai/chalk-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "./ChatPanel";

afterEach(cleanup);

describe("ChatPanel", () => {
  it("uses app appearance tokens for the panel and composer", () => {
    render(<ChatPanel messages={[]} onSendMessage={async () => undefined} />);

    expect(screen.getByRole("complementary", { name: "Chat panel" })).toHaveClass("text-[var(--chalk-app-text)]");
    expect(screen.getByLabelText("Chat messages")).toHaveClass("bg-[var(--chalk-app-panel)]");
    expect(screen.getByLabelText("Message")).toHaveClass("bg-[var(--chalk-app-input)]", "border-[var(--chalk-app-line)]", "text-[var(--chalk-app-text)]");
  });

  it("uploads and sends an attachment without requiring text", async () => {
    const onUploadAttachment = vi.fn(async (file: ChatUploadFile) => {
      if ("bytes" in file) return { attachmentId: "attachment-1", fileName: file.fileName, mimeType: file.mimeType as "text/plain", byteLength: file.bytes.byteLength };
      return { attachmentId: "attachment-1", fileName: file.name, mimeType: file.type as "text/plain", byteLength: file.size };
    });
    const onSendMessage = vi.fn(async () => undefined);
    render(<ChatPanel messages={[]} onSendMessage={onSendMessage} onUploadAttachment={onUploadAttachment} />);

    const fileInput = screen.getByLabelText("Choose attachments");
    const nativeClick = vi.spyOn(fileInput, "click");
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    expect(nativeClick).toHaveBeenCalledOnce();
    nativeClick.mockRestore();

    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(onUploadAttachment).toHaveBeenCalledWith(file));
    expect(onSendMessage).toHaveBeenCalledWith({
      text: "",
      attachments: [{ attachmentId: "attachment-1", fileName: "note.txt", mimeType: "text/plain", byteLength: 5 }],
    });
  });

  it("uses a custom raw-file picker and keeps attachment-only staging removable", async () => {
    const rawFile: ChatUploadFile = { fileName: "note.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("hello").buffer as ArrayBuffer };
    const pickChatFiles = vi.fn(async () => [rawFile] as const);
    const onUploadAttachment = vi.fn(async (file: ChatUploadFile) => {
      if ("bytes" in file) return { attachmentId: "attachment-raw", fileName: file.fileName, mimeType: file.mimeType as "text/plain", byteLength: file.bytes.byteLength };
      return { attachmentId: "attachment-raw", fileName: file.name, mimeType: file.type as "text/plain", byteLength: file.size };
    });
    const onSendMessage = vi.fn(async () => undefined);
    render(<ChatPanel messages={[]} onSendMessage={onSendMessage} onUploadAttachment={onUploadAttachment} pickChatFiles={pickChatFiles} />);

    expect(screen.queryByLabelText("Choose attachments")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(pickChatFiles).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("Attachments")).toHaveTextContent("note.txt");

    fireEvent.click(screen.getByRole("button", { name: "Remove note.txt" }));
    expect(screen.queryByLabelText("Attachments")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(screen.getByLabelText("Attachments")).toHaveTextContent("note.txt"));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(onUploadAttachment).toHaveBeenCalledWith(rawFile));
    expect(onSendMessage).toHaveBeenCalledWith({ text: "", attachments: [{ attachmentId: "attachment-raw", fileName: "note.txt", mimeType: "text/plain", byteLength: 5 }] });
  });

  it("rejects a selection that would exceed five attachments", () => {
    const onSendMessage = vi.fn(async () => undefined);
    render(<ChatPanel messages={[]} onSendMessage={onSendMessage} onUploadAttachment={async () => ({ attachmentId: "unused", fileName: "unused", mimeType: "text/plain", byteLength: 1 })} />);
    const files = Array.from({ length: 6 }, (_, index) => new File(["x"], `${index}.txt`, { type: "text/plain" }));

    fireEvent.change(screen.getByLabelText("Choose attachments"), { target: { files } });

    expect(screen.getByRole("alert")).toHaveTextContent("You can attach up to 5 files.");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("does not mark a new tail message read while the user is scrolled up", async () => {
    const onMarkRead = vi.fn(async () => undefined);
    const onSendMessage = vi.fn(async () => undefined);
    const { rerender } = render(<ChatPanel messages={[message("1")]} onSendMessage={onSendMessage} onMarkRead={onMarkRead} />);
    await waitFor(() => expect(onMarkRead).toHaveBeenCalledWith("1"));
    onMarkRead.mockClear();

    const scroller = screen.getByLabelText("Chat messages");
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    fireEvent.scroll(scroller);
    rerender(<ChatPanel messages={[message("1"), message("2")]} onSendMessage={onSendMessage} onMarkRead={onMarkRead} />);

    await Promise.resolve();
    expect(onMarkRead).not.toHaveBeenCalledWith("2");
    expect(scroller.scrollTop).toBe(100);
  });

  it("marks the latest durable message intersecting the real viewport", () => {
    const onMarkRead = vi.fn();
    const { rerender } = render(<ChatPanel messages={[message("1")]} onSendMessage={async () => undefined} onMarkRead={onMarkRead} />);
    onMarkRead.mockClear();
    const scroller = screen.getByLabelText("Chat messages");
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    fireEvent.scroll(scroller);
    rerender(<ChatPanel messages={[message("1"), message("2"), message("3")]} onSendMessage={async () => undefined} onMarkRead={onMarkRead} />);
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(0, 200));
    const bubbles = scroller.querySelectorAll<HTMLElement>("[data-chat-sequence]");
    vi.spyOn(bubbles[0]!, "getBoundingClientRect").mockReturnValue(rect(-100, -20));
    vi.spyOn(bubbles[1]!, "getBoundingClientRect").mockReturnValue(rect(20, 80));
    vi.spyOn(bubbles[2]!, "getBoundingClientRect").mockReturnValue(rect(240, 300));

    fireEvent.scroll(scroller);

    expect(onMarkRead).toHaveBeenCalledWith("2");
    expect(onMarkRead).not.toHaveBeenCalledWith("3");
  });
});

function message(sequence: string): ChatMessage {
  return {
    messageId: `message-${sequence}`,
    clientMessageId: `client-${sequence}`,
    sequence,
    participantId: "remote",
    displayName: "Grace",
    text: `Message ${sequence}`,
    attachments: [],
    createdAt: "2026-07-30T10:00:00.000Z",
  };
}

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
}
