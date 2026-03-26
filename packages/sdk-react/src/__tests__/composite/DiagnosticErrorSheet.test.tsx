import { describe, expect, it, vi } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";

import { DiagnosticErrorSheet } from "../../components/composite/DiagnosticErrorSheet";

describe("DiagnosticErrorSheet", () => {
  it("falls back to legacy copy when async clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    navigator.clipboard.writeText = writeText;
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      value: execCommand,
      configurable: true,
    });

    const { getByText, findByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-456" />);

    fireEvent.click(getByText("Copy Full Debug"));

    await findByText("Copied Full Debug");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith("copy");
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
