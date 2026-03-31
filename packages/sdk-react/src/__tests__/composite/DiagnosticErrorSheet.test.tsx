import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

import { DiagnosticErrorSheet } from "../../components/composite/DiagnosticErrorSheet";
import * as debugExport from "../../utils/debugExport";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DiagnosticErrorSheet", () => {
  it("downloads the prebuilt debug text as plain text", async () => {
    const downloadDebugText = vi.spyOn(debugExport, "downloadDebugText").mockImplementation(() => {});

    const { getByText, findByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-789" />);

    await findByText("Download Debug TXT");
    fireEvent.click(getByText("Download Debug TXT"));

    await findByText("Downloaded Debug TXT");
    expect(downloadDebugText).toHaveBeenCalledTimes(1);
    expect(String(downloadDebugText.mock.calls[0]?.[0])).toContain("Failed to join room");
    expect(String(downloadDebugText.mock.calls[0]?.[0])).toContain("CHK-789");
  });

  it("does not try clipboard copy when downloading debug text", async () => {
    const downloadDebugText = vi.spyOn(debugExport, "downloadDebugText").mockImplementation(() => {});
    const writeText = vi.fn().mockResolvedValue(undefined);
    navigator.clipboard.writeText = writeText;

    const { getByText, findByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-456" />);

    await findByText("Download Debug TXT");
    fireEvent.click(getByText("Download Debug TXT"));

    await findByText("Downloaded Debug TXT");
    expect(downloadDebugText).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("shows the full debug action on the real diagnostic sheet", async () => {
    const { findByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-123" />);

    expect(await findByText("Download Debug TXT")).toBeTruthy();
    expect(await findByText(/share it with your support admin/i)).toBeTruthy();
  });

  it("does not silently report downloaded while the debug payload is still preparing", async () => {
    const downloadDebugText = vi.spyOn(debugExport, "downloadDebugText").mockImplementation(() => {});

    const { getByText } = render(<DiagnosticErrorSheet error="Failed to join room" supportCode="CHK-321" />);

    fireEvent.click(getByText("Preparing Debug..."));

    expect(downloadDebugText).not.toHaveBeenCalled();
    expect(getByText("Preparing Debug...")).toBeTruthy();
  });
});
