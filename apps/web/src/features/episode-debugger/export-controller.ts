import type { DiagnosticExportStatus } from "@chalk/diagnostics-contracts";
import { EpisodeDiagnosticsApiClient } from "./api-client";
import { abortableDelay } from "./controller-utils";

export type DiagnosticExportPhase = "idle" | "starting" | "polling" | "ready" | "failed" | "cancelling" | "cancelled";

export type DiagnosticExportState = Readonly<{
  phase: DiagnosticExportPhase;
  job?: DiagnosticExportStatus;
  error?: string;
}>;

type ExportControllerOptions = Readonly<{
  api: EpisodeDiagnosticsApiClient;
  reference: string;
  onChange: (state: DiagnosticExportState) => void;
  pollIntervalMilliseconds?: number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

export class DiagnosticExportController {
  private readonly api: EpisodeDiagnosticsApiClient;
  private readonly reference: string;
  private readonly onChange: (state: DiagnosticExportState) => void;
  private readonly pollIntervalMilliseconds: number;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private abortController?: AbortController;
  private state: DiagnosticExportState = { phase: "idle" };

  constructor(options: ExportControllerOptions) {
    this.api = options.api;
    this.reference = options.reference;
    this.onChange = options.onChange;
    this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 1_000;
    this.wait = options.delay ?? abortableDelay;
  }

  getState(): DiagnosticExportState {
    return this.state;
  }

  async start(cursorTo?: number): Promise<void> {
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.setState({ phase: "starting", error: undefined });
    try {
      let job = await this.api.createExportJob(this.reference, cursorTo, signal);
      this.setState({ phase: "polling", job });
      while (job.state === "queued" || job.state === "running") {
        await this.wait(this.pollIntervalMilliseconds, signal);
        job = await this.api.readExportJob(this.reference, job.jobId, signal);
        this.setState({ phase: "polling", job });
      }
      if (job.state === "succeeded") {
        this.setState({ phase: "ready", job });
        return;
      }
      if (job.state === "cancelled") {
        this.setState({ phase: "cancelled", job });
        return;
      }
      this.setState({
        phase: "failed",
        job,
        error: job.errorReason ?? `Export job ${job.state}`,
      });
    } catch (error) {
      if (signal.aborted) return;
      this.setState({
        phase: "failed",
        error: error instanceof Error ? error.message : "The export job failed",
      });
    }
  }

  async cancel(): Promise<void> {
    const job = this.state.job;
    if (!job || (job.state !== "queued" && job.state !== "running")) return;
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.setState({ phase: "cancelling" });
    try {
      const cancelled = await this.api.cancelExportJob(this.reference, job.jobId, this.abortController.signal);
      this.setState({ phase: "cancelled", job: cancelled });
    } catch (error) {
      this.setState({
        phase: "failed",
        error: error instanceof Error ? error.message : "The export job could not be cancelled",
      });
    }
  }

  downloadUrl(): string | undefined {
    if (this.state.phase !== "ready" || !this.state.job) return undefined;
    return this.api.exportDownloadUrl(this.reference, this.state.job.jobId);
  }

  stop(): void {
    this.abortController?.abort();
  }

  private setState(update: Partial<DiagnosticExportState>): void {
    this.state = { ...this.state, ...update };
    this.onChange(this.state);
  }
}
