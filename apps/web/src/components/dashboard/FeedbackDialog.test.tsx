// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { submitFeedbackReport } from "../../lib/dashboard-api";
import { installDialogMethods } from "./__tests__/dialog-fixtures";
import { DashboardFeedbackDialog } from "./FeedbackDialog";

const mocks = vi.hoisted(() => {
  const journey = {
    context: {
      journeyId: "11111111-1111-4111-8111-111111111111",
      rootJourneyId: "22222222-2222-4222-8222-222222222222",
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    },
  };

  return {
    captureFeedbackScreenshot: vi.fn(),
    collectBrowserFeedbackEvidence: vi.fn(),
    submitFeedbackReport: vi.fn(),
    useWebTelemetry: vi.fn(() => ({ journey })),
  };
});

vi.mock("@q9labsai/chalk-react/utils", () => ({
  captureFeedbackScreenshot: mocks.captureFeedbackScreenshot,
  collectBrowserFeedbackEvidence: mocks.collectBrowserFeedbackEvidence,
}));

vi.mock("../../lib/dashboard-api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/dashboard-api")>("../../lib/dashboard-api");
  return { ...actual, submitFeedbackReport: mocks.submitFeedbackReport };
});

vi.mock("../../lib/web-telemetry-context", () => ({ useWebTelemetry: mocks.useWebTelemetry }));

const capturedScreenshot = {
  state: "captured" as const,
  mime_type: "image/png" as const,
  width: 640,
  height: 480,
  captured_at: "2026-08-19T13:00:00.000Z",
  data_base64: "c2NyZWVuc2hvdA==",
};

beforeEach(() => {
  installDialogMethods();
  vi.clearAllMocks();
  mocks.captureFeedbackScreenshot.mockResolvedValue(capturedScreenshot);
  mocks.collectBrowserFeedbackEvidence.mockReturnValue({
    sdk: { client: "@q9labsai/chalk-client", react: "@q9labsai/chalk-react" },
    platform: { kind: "web", browser_name: "Test Browser" },
    local_state: { dashboard_requests: [{ action: "feedback", pending: true }] },
    cookies: { theme: "dark" },
  });
  mocks.submitFeedbackReport.mockResolvedValue({
    schema_version: "FeedbackReportReceipt/v1",
    id: "33333333-3333-4333-8333-333333333333",
    submitted_at: "2026-08-19T13:00:01.000Z",
  });
});

afterEach(cleanup);

describe("DashboardFeedbackDialog", () => {
  it("captures a screenshot and submits a correlated, normalized report", async () => {
    const onClose = vi.fn();
    const captureRoot = document.createElement("main");

    render(<DashboardFeedbackDialog open tenantID="tenant-1" captureRootRef={{ current: captureRoot }} onClose={onClose} />);

    expect((await screen.findByAltText("Dashboard screenshot preview")).getAttribute("src")).toBe("data:image/png;base64,c2NyZWVuc2hvdA==");
    fireEvent.click(screen.getByRole("radio", { name: "Feature request" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "  The toolbar clips.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    await waitFor(() => expect(submitFeedbackReport).toHaveBeenCalledOnce());
    const submitCall = mocks.submitFeedbackReport.mock.calls[0];
    if (!submitCall) throw new Error("expected Feedback submission");
    const [tenantID, request, idempotencyKey] = submitCall;
    expect(tenantID).toBe("tenant-1");
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(request).toMatchObject({
      schema_version: "FeedbackReportRequest/v1",
      category: "feature_request",
      message: "The toolbar clips.",
      source: "dashboard",
      screenshot: {
        schema_version: "FeedbackScreenshot/v1",
        mime_type: "image/png",
        width: 640,
        height: 480,
        captured_at: capturedScreenshot.captured_at,
        data_base64: capturedScreenshot.data_base64,
      },
      evidence: {
        correlations: {
          journey_id: "11111111-1111-4111-8111-111111111111",
          root_journey_id: "22222222-2222-4222-8222-222222222222",
          trace_id: "0123456789abcdef0123456789abcdef",
          span_id: "0123456789abcdef",
        },
        screenshot: { state: "captured", captured_at: capturedScreenshot.captured_at },
      },
    });
    expect(request.evidence.cookies.entries).toEqual(
      expect.arrayContaining([
        { name: "chalk_theme", present: true, value: "dark" },
        { name: "account", present: true },
      ]),
    );
    expect((await screen.findByRole("status")).textContent).toContain("Thanks. Chalk received your feedback.");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("removes screenshots and surfaces submit failures without closing", async () => {
    const onClose = vi.fn();
    const captureRoot = document.createElement("main");
    mocks.submitFeedbackReport.mockRejectedValueOnce(new Error("Feedback service unavailable"));

    render(<DashboardFeedbackDialog open tenantID="tenant-1" captureRootRef={{ current: captureRoot }} onClose={onClose} />);

    expect(await screen.findByAltText("Dashboard screenshot preview")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByAltText("Dashboard screenshot preview")).toBeNull();
    expect(screen.getByText("No screenshot attached.")).not.toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "A report that fails." } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Feedback service unavailable");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send feedback" }).hasAttribute("disabled")).toBe(false);
    const submitCall = mocks.submitFeedbackReport.mock.calls[0];
    if (!submitCall) throw new Error("expected Feedback submission");
    const [, request] = submitCall;
    expect(request.screenshot).toBeUndefined();
    expect(request.evidence.screenshot).toEqual({ state: "removed" });

    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(submitFeedbackReport).toHaveBeenCalledTimes(2));
    const retryCall = mocks.submitFeedbackReport.mock.calls[1];
    if (!retryCall) throw new Error("expected Feedback retry");
    expect(retryCall[1]).toEqual(request);
    expect(retryCall[2]).toBe(submitCall[2]);
  });

  it("clears the prior Tenant screenshot before a reopened dialog captures again", async () => {
    let resolveCapture: ((result: { state: "unavailable"; failure_code: "capture_failed" }) => void) | undefined;
    const nextCapture = new Promise<{ state: "unavailable"; failure_code: "capture_failed" }>((resolve) => {
      resolveCapture = resolve;
    });
    mocks.captureFeedbackScreenshot.mockResolvedValueOnce(capturedScreenshot).mockReturnValueOnce(nextCapture);
    const captureRoot = document.createElement("main");
    const view = render(<DashboardFeedbackDialog open tenantID="tenant-1" captureRootRef={{ current: captureRoot }} onClose={() => undefined} />);
    expect(await screen.findByAltText("Dashboard screenshot preview")).not.toBeNull();

    view.rerender(<DashboardFeedbackDialog open={false} tenantID="tenant-1" captureRootRef={{ current: captureRoot }} onClose={() => undefined} />);
    view.rerender(<DashboardFeedbackDialog open tenantID="tenant-2" captureRootRef={{ current: captureRoot }} onClose={() => undefined} />);

    await waitFor(() => expect(mocks.captureFeedbackScreenshot).toHaveBeenCalledTimes(2));
    expect(screen.queryByAltText("Dashboard screenshot preview")).toBeNull();
    expect(screen.getByText("Capturing a safe Dashboard screenshot…")).not.toBeNull();
    resolveCapture?.({ state: "unavailable", failure_code: "capture_failed" });
    expect(await screen.findByText("Screenshot unavailable (capture_failed).")).not.toBeNull();
  });

  it("shows capture failures and keeps submission disabled for blank messages", async () => {
    mocks.captureFeedbackScreenshot.mockResolvedValueOnce({ state: "unavailable", failure_code: "capture_failed" });
    const captureRoot = document.createElement("main");

    render(<DashboardFeedbackDialog open tenantID="tenant-1" captureRootRef={{ current: captureRoot }} onClose={() => undefined} />);

    expect(await screen.findByText("Screenshot unavailable (capture_failed).")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Remove" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Send feedback" }).hasAttribute("disabled")).toBe(true);
  });
});
