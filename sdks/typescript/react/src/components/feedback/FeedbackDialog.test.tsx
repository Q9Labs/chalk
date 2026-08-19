// @vitest-environment happy-dom

import type { FeedbackPrepareInput, FeedbackScreenshotCapture, FeedbackScreenshotUnavailable } from "@q9labsai/chalk-client";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "../../test-support/test-client";
import { SkinProvider } from "../skin-context";
import { FeedbackDialog } from "./FeedbackDialog";

const domToJpeg = vi.hoisted(() => vi.fn());
vi.mock("modern-screenshot", () => ({ domToJpeg }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FeedbackDialog", () => {
  it("captures safe context before submitting one message", async () => {
    domToJpeg.mockResolvedValue("data:image/jpeg;base64,ZmFrZQ==");
    const send = vi.fn(async () => ({ schema_version: "FeedbackReceipt/v1", id: "feedback-1", submitted_at: "2026-01-01T00:00:00.000Z" }));
    const prepare = vi.fn(async (input: FeedbackPrepareInput = {}) => {
      const unavailable: FeedbackScreenshotUnavailable = { state: "unavailable", failure_code: "unsupported" };
      const capture: FeedbackScreenshotCapture | FeedbackScreenshotUnavailable = (await input.screenshot_provider?.()) ?? unavailable;
      const screenshot = capture.state === "captured" || capture.state === "partial" ? { schema_version: "FeedbackScreenshot/v1", ...capture } : undefined;
      return {
        idempotency_key: "feedback-key",
        evidence: { screenshot: capture },
        screenshot,
        send,
      };
    });
    const client = createTestClient();
    Object.defineProperty(client, "feedback", { configurable: true, value: { prepare, send, dispose: vi.fn() } });
    const captureRoot = document.createElement("main");
    captureRoot.getBoundingClientRect = () => new DOMRect(0, 0, 640, 480);

    render(
      <SkinProvider skin="classic">
        <FeedbackDialog isOpen onClose={vi.fn()} client={client} captureRootRef={{ current: captureRoot }} />
      </SkinProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Send feedback" })).toBeTruthy();
    await waitFor(() => expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ source: "embedded", screenshot_provider: expect.any(Function) })));
    expect(await screen.findByAltText("Screenshot preview")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "The control bar is clipped." } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith({ category: "bug", message: "The control bar is clipped." }));
    expect(await screen.findByRole("status")).toHaveTextContent("Chalk received your feedback");
  });
});
