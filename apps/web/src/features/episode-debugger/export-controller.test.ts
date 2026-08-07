import { describe, expect, it, vi } from "vitest";
import type { DiagnosticExportStatus } from "@chalk/diagnostics-contracts";
import type { EpisodeDiagnosticsApiClient } from "./api-client";
import { DiagnosticExportController, type DiagnosticExportState } from "./export-controller";
import { TEST_REFERENCE } from "./test-fixtures";

const job = (state: DiagnosticExportStatus["state"], overrides: Partial<DiagnosticExportStatus> = {}): DiagnosticExportStatus => ({
  schemaVersion: "ExportJob/v1",
  jobId: "export-job-1",
  reference: TEST_REFERENCE,
  state,
  createdAt: "2026-08-04T10:00:00.000Z",
  leaseEndsAt: "2026-08-04T10:30:00.000Z",
  cursorFrom: 0,
  cursorTo: 42,
  ...overrides,
});

describe("DiagnosticExportController", () => {
  it("polls an asynchronous job to success and exposes authenticated navigation", async () => {
    const states: DiagnosticExportState[] = [];
    const api = {
      createExportJob: vi.fn().mockResolvedValue(job("queued")),
      readExportJob: vi.fn().mockResolvedValue(job("succeeded")),
      exportDownloadUrl: vi.fn().mockReturnValue("/_internal/episode-diagnostics/ref/export-jobs/export-job-1/download"),
    } as unknown as EpisodeDiagnosticsApiClient;
    const controller = new DiagnosticExportController({ api, reference: TEST_REFERENCE, onChange: (state) => states.push(state), delay: async () => undefined });

    await controller.start(42);

    expect(states.map((state) => state.phase)).toEqual(["starting", "polling", "polling", "ready"]);
    expect(controller.downloadUrl()).toContain("/download");
    expect(api.exportDownloadUrl).toHaveBeenCalledWith(TEST_REFERENCE, "export-job-1");
  });

  it("surfaces failed jobs without attempting a browser Blob", async () => {
    const api = {
      createExportJob: vi.fn().mockResolvedValue(job("failed", { errorReason: "quota_exceeded" })),
    } as unknown as EpisodeDiagnosticsApiClient;
    const controller = new DiagnosticExportController({ api, reference: TEST_REFERENCE, onChange: () => undefined });

    await controller.start();

    expect(controller.getState()).toMatchObject({ phase: "failed", error: "quota_exceeded" });
    expect(controller.downloadUrl()).toBeUndefined();
  });

  it("cancels a queued job", async () => {
    let releaseDelay: (() => void) | undefined;
    const api = {
      createExportJob: vi.fn().mockResolvedValue(job("queued")),
      cancelExportJob: vi.fn().mockResolvedValue(job("cancelled")),
    } as unknown as EpisodeDiagnosticsApiClient;
    const controller = new DiagnosticExportController({
      api,
      reference: TEST_REFERENCE,
      onChange: () => undefined,
      delay: () =>
        new Promise<void>((resolve) => {
          releaseDelay = resolve;
        }),
    });

    const running = controller.start();
    await vi.waitFor(() => expect(controller.getState().phase).toBe("polling"));
    await controller.cancel();
    releaseDelay?.();
    await running;

    expect(api.cancelExportJob).toHaveBeenCalledWith(TEST_REFERENCE, "export-job-1", expect.any(AbortSignal));
    expect(controller.getState().phase).toBe("cancelled");
  });

  it("aborts active polling when the controller stops", async () => {
    const api = {
      createExportJob: vi.fn().mockResolvedValue(job("queued")),
    } as unknown as EpisodeDiagnosticsApiClient;
    const controller = new DiagnosticExportController({ api, reference: TEST_REFERENCE, onChange: () => undefined, pollIntervalMilliseconds: 60_000 });

    const running = controller.start();
    await vi.waitFor(() => expect(controller.getState().phase).toBe("polling"));
    controller.stop();
    await running;

    expect(controller.getState().phase).toBe("polling");
  });
});
