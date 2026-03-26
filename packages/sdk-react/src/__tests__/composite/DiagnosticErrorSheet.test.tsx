import { describe, expect, it, vi } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";

import { DiagnosticErrorSheet } from "../../components/composite/DiagnosticErrorSheet";

describe("DiagnosticErrorSheet", () => {
  it("copies the prebuilt debug text with writeText first", async () => {
    let clipboardText = "";
    const writeText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockImplementation(async () => clipboardText);
    navigator.clipboard.writeText = vi.fn(async (text: string) => {
      clipboardText = text;
      return writeText(text);
    });
    navigator.clipboard.readText = readText;

    const { getByText, findByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-789" />);

    await findByText("Copy Full Debug");
    fireEvent.click(getByText("Copy Full Debug"));

    await findByText("Copied Full Debug");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0]?.[0])).toContain("Failed to join room");
    expect(String(writeText.mock.calls[0]?.[0])).toContain("CHK-789");
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

    await findByText("Copy Full Debug");
    fireEvent.click(getByText("Copy Full Debug"));

    await findByText("Copied Full Debug");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith("copy");

    globalThis.ClipboardItem = originalClipboardItem;
  });

  it("shows the full debug action on the real diagnostic sheet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    navigator.clipboard.writeText = writeText;

    const { getByText, findByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-123" />);

    await findByText("Copy Full Debug");
    fireEvent.click(getByText("Copy Full Debug"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(String(writeText.mock.calls[0]?.[0])).toContain("Failed to join room");
    expect(String(writeText.mock.calls[0]?.[0])).toContain("CHK-123");
  });

  it("does not silently report copied while the debug payload is still preparing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    navigator.clipboard.writeText = writeText;

    const { getByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-321" />);

    fireEvent.click(getByText("Preparing Debug..."));

    expect(writeText).not.toHaveBeenCalled();
    expect(getByText("Preparing Debug...")).toBeTruthy();
    expect(getByText(/Debug report still preparing/i)).toBeTruthy();
  });
});
