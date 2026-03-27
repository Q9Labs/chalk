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
    expect(getByText("Full debug text ready")).toBeTruthy();
  });

  it("tries same-gesture execCommand before async clipboard writes", async () => {
    let clipboardText = "";
    const writeText = vi.fn().mockResolvedValue(undefined);
    navigator.clipboard.writeText = vi.fn(async (text: string) => {
      clipboardText = text;
      return writeText(text);
    });
    navigator.clipboard.readText = vi.fn(async () => clipboardText);
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
    let clipboardText = "";
    const writeText = vi.fn().mockResolvedValue(undefined);
    navigator.clipboard.writeText = vi.fn(async (text: string) => {
      clipboardText = text;
      return writeText(text);
    });
    navigator.clipboard.readText = vi.fn(async () => clipboardText);
    Object.defineProperty(document, "execCommand", {
      value: undefined,
      configurable: true,
    });

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

  it("shows the selected full debug text when clipboard writes fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    navigator.clipboard.writeText = writeText;
    navigator.clipboard.write = undefined as never;
    navigator.clipboard.readText = undefined as never;
    Object.defineProperty(document, "execCommand", {
      value: undefined,
      configurable: true,
    });

    const { getByText, findByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-654" />);

    await findByText("Copy Full Debug");
    fireEvent.click(getByText("Copy Full Debug"));

    await findByText("Full debug text ready");
    expect(getByText(/clipboard stayed empty|long-press the selected text|press Cmd\/Ctrl\+C/i)).toBeTruthy();
  });

  it("still surfaces the selected full debug text when async clipboard verification mismatches", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    navigator.clipboard.writeText = writeText;
    navigator.clipboard.readText = vi.fn(async () => "stale clipboard value");
    navigator.clipboard.write = undefined as never;
    Object.defineProperty(document, "execCommand", {
      value: undefined,
      configurable: true,
    });

    const { getByText, findByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-741" />);

    await findByText("Copy Full Debug");
    fireEvent.click(getByText("Copy Full Debug"));

    await findByText("Copied Full Debug");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(getByText("Full debug text ready")).toBeTruthy();
  });

  it("shows the selected full debug text even when execCommand becomes the effective fallback", async () => {
    const execCommand = vi.fn(() => true);
    navigator.clipboard.writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    navigator.clipboard.write = undefined as never;
    navigator.clipboard.readText = vi.fn(async () => "stale clipboard value");
    Object.defineProperty(document, "execCommand", {
      value: execCommand,
      configurable: true,
    });

    const { getByText, findByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-987" />);

    await findByText("Copy Full Debug");
    fireEvent.click(getByText("Copy Full Debug"));

    await findByText("Copied Full Debug");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(getByText("Full debug text ready")).toBeTruthy();
  });
});
