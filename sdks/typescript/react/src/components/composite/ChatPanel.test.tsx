// @vitest-environment happy-dom

import type { ChatMessage, ChatUploadFile } from "@q9labsai/chalk-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "../../bindings/context";
import { createSnapshot, createTestClient } from "../../test-support/test-client";
import { ChatPanel } from "./ChatPanel";

afterEach(cleanup);

function renderPanel(client = createTestClient()) {
  return render(
    <ChalkProvider client={client}>
      <ChatPanel />
    </ChalkProvider>,
  );
}

describe("ChatPanel", () => {
  it("reads chat state from the provider and uses app appearance tokens", () => {
    const client = createTestClient();
    renderPanel(client);
    const panel = screen.getByRole("complementary", { name: "Chat panel" });
    expect(panel).toHaveClass("text-[var(--chalk-app-text)]");
    expect(panel.querySelector('[data-chalk-chrome="true"]')).toBeInTheDocument();
    expect(screen.getByLabelText("Chat messages")).toHaveClass("bg-[var(--chalk-app-panel)]");
  });

  it("uploads and sends an attachment through the provider client", async () => {
    const client = createTestClient(createSnapshot(["sendChat"]));
    const rawFile: ChatUploadFile = { fileName: "note.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("hello").buffer as ArrayBuffer };
    const attachment = { attachmentId: "attachment-1", fileName: "note.txt", mimeType: "text/plain" as const, byteLength: 5 };
    const pickChatFiles = vi.fn(async () => [rawFile] as const);
    const upload = vi.spyOn(client.chat.files, "upload").mockResolvedValue(attachment);
    const send = vi.spyOn(client.chat, "send").mockResolvedValue();
    render(
      <ChalkProvider client={client}>
        <ChatPanel pickChatFiles={pickChatFiles} />
      </ChalkProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(pickChatFiles).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText("Attachments")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(upload).toHaveBeenCalledWith(rawFile));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ text: "", attachments: [attachment] }));
  });

  it("marks the latest durable message read from the real viewport", async () => {
    const first = message("1");
    const second = message("2");
    const client = createTestClient(createSnapshot(["sendChat"]));
    client.setSnapshot({ ...client.getSnapshot(), chat: { ...client.getSnapshot().chat, status: "ready", messages: [first] } });
    const markRead = vi.spyOn(client.chat, "markRead").mockResolvedValue();
    const view = renderPanel(client);
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(first.messageId));
    markRead.mockClear();
    actSetSnapshot(client, { ...client.getSnapshot(), chat: { ...client.getSnapshot().chat, messages: [first, second] } });
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(second.messageId));
    expect(view.container.querySelector('[aria-label="Chat messages"]')).toBeInTheDocument();
  });
});

function actSetSnapshot(client: ReturnType<typeof createTestClient>, snapshot: ReturnType<typeof client.getSnapshot>) {
  client.setSnapshot(snapshot);
}

function message(sequence: string): ChatMessage {
  return { messageId: `message-${sequence}`, clientMessageId: `client-${sequence}`, sequence, participantId: "remote", displayName: "Grace", text: `Message ${sequence}`, attachments: [], createdAt: "2026-07-30T10:00:00.000Z" };
}
