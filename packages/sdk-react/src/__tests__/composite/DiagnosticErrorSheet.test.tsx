import { describe, expect, it, vi } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";

import { DiagnosticErrorSheet } from "../../components/composite/DiagnosticErrorSheet";

describe("DiagnosticErrorSheet", () => {
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
