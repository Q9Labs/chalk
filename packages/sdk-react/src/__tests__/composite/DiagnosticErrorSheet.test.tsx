import { describe, expect, it, vi } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";

import { DiagnosticErrorSheet } from "../../components/composite/DiagnosticErrorSheet";

describe("DiagnosticErrorSheet", () => {
  it("uses ClipboardItem write during the click flow when available", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const originalClipboardItem = globalThis.ClipboardItem;
    const clipboardItemSpy = vi.fn((items: Record<string, Promise<Blob>>) => items);

    navigator.clipboard.write = write;
    // @ts-expect-error test shim
    globalThis.ClipboardItem = clipboardItemSpy;

    const { getByText, findByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-789" />);

    fireEvent.click(getByText("Copy Full Debug"));

    await findByText("Copied Full Debug");
    expect(clipboardItemSpy).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);

    globalThis.ClipboardItem = originalClipboardItem;
  });

  it("falls back to legacy copy when async clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    navigator.clipboard.writeText = writeText;
    const execCommand = vi.fn(() => true);
    const originalClipboardItem = globalThis.ClipboardItem;
    // @ts-expect-error test shim
    globalThis.ClipboardItem = undefined;
    Object.defineProperty(document, "execCommand", {
      value: execCommand,
      configurable: true,
    });

    const { getByText, findByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-456" />);

    fireEvent.click(getByText("Copy Full Debug"));

    await findByText("Copied Full Debug");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith("copy");

    globalThis.ClipboardItem = originalClipboardItem;
  });

  it("shows the full debug action on the real diagnostic sheet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    navigator.clipboard.writeText = writeText;

    const { getByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-123" />);

    fireEvent.click(getByText("Copy Full Debug"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(String(writeText.mock.calls[0]?.[0])).toContain("Failed to join room");
    expect(String(writeText.mock.calls[0]?.[0])).toContain("CHK-123");
  });
});
