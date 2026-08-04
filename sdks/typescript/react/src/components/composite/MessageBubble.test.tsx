// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageBubble } from "./MessageBubble";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MessageBubble", () => {
  it("renders canonical attachments and resolves protected downloads", async () => {
    const popup = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
    const resolveAttachment = vi.fn(async () => "https://download.test/report");
    render(<MessageBubble content="" senderName="Ada" timestamp="2026-07-30T10:00:00.000Z" attachments={[{ attachmentId: "attachment-1", fileName: "report.pdf", mimeType: "application/pdf", byteLength: 2048 }]} onResolveAttachmentUrl={resolveAttachment} />);

    expect(screen.getByText("2 KB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download report.pdf" }));

    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.opener).toBeNull();
    await waitFor(() => expect(resolveAttachment).toHaveBeenCalledWith("attachment-1"));
    expect(popup.location.href).toBe("https://download.test/report");
  });

  it("closes its reserved download tab when URL resolution fails", async () => {
    const popup = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
    vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
    render(
      <MessageBubble
        content=""
        senderName="Ada"
        timestamp="2026-07-30T10:00:00.000Z"
        attachments={[{ attachmentId: "attachment-1", fileName: "report.pdf", mimeType: "application/pdf", byteLength: 2048 }]}
        onResolveAttachmentUrl={async () => {
          throw new Error("expired");
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download report.pdf" }));

    await waitFor(() => expect(popup.close).toHaveBeenCalledOnce());
  });

  it("resolves a fresh protected URL on click instead of reusing the cached image preview", async () => {
    const popup = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
    vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
    const resolveAttachment = vi.fn().mockResolvedValueOnce("https://download.test/expired-preview").mockResolvedValueOnce("https://download.test/fresh-click");
    render(<MessageBubble content="" senderName="Ada" timestamp="2026-07-30T10:00:00.000Z" attachments={[{ attachmentId: "attachment-1", fileName: "diagram.png", mimeType: "image/png", byteLength: 2048 }]} onResolveAttachmentUrl={resolveAttachment} />);

    await waitFor(() => expect(screen.getByRole("img", { name: "diagram.png" })).toHaveAttribute("src", "https://download.test/expired-preview"));
    fireEvent.click(screen.getByRole("button", { name: "Download diagram.png" }));

    await waitFor(() => expect(resolveAttachment).toHaveBeenCalledTimes(2));
    expect(popup.location.href).toBe("https://download.test/fresh-click");
  });

  it("uses pending, sent, and read statuses without a delivered state", () => {
    const { rerender } = render(<MessageBubble content="Update" senderName="Ada" timestamp="2026-07-30T10:00:00.000Z" isLocal status="pending" />);
    expect(screen.getByText("Pending")).toBeInTheDocument();

    rerender(<MessageBubble content="Update" senderName="Ada" timestamp="2026-07-30T10:00:00.000Z" isLocal status="sent" />);
    expect(screen.getByText("Sent")).toBeInTheDocument();

    rerender(<MessageBubble content="Update" senderName="Ada" timestamp="2026-07-30T10:00:00.000Z" isLocal status="read" readBy={[{ participantId: "grace", participantGeneration: 2, readThroughSequence: "8", readAt: "2026-07-30T10:01:00.000Z" }]} participantNames={{ grace: "Grace" }} />);
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getAllByText(/Read by: Grace/u)).not.toHaveLength(0);
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });
});
