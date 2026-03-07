import { ChalkError } from "../errors/chalk-error";
import { createBrowserIncidentContext, createSupportCode, type ChalkIncident, type ChalkIncidentBreadcrumb, type ChalkIncidentConfig, type ChalkIncidentInput, type ChalkIncidentSource } from "../incident.ts";
import { wideEvents } from "../wide-events/index";

interface ChalkSessionIncidentSnapshot {
  roomId: string | null;
  localParticipantId: string | null;
}

interface ChalkSessionIncidentPipelineArgs {
  emitError: (error: ChalkError) => void;
  getSnapshot: () => ChalkSessionIncidentSnapshot;
}

const DEFAULT_MAX_BREADCRUMBS = 40;

export class ChalkSessionIncidentPipeline {
  private config?: ChalkIncidentConfig;
  private breadcrumbs: ChalkIncidentBreadcrumb[] = [];
  private sequence = 0;

  constructor(private readonly args: ChalkSessionIncidentPipelineArgs) {}

  configure(config?: ChalkIncidentConfig): void {
    this.config = config;
    const maxBreadcrumbs = config?.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    if (this.breadcrumbs.length > maxBreadcrumbs) {
      this.breadcrumbs = this.breadcrumbs.slice(-maxBreadcrumbs);
    }
  }

  recordBreadcrumb(
    breadcrumb: Omit<ChalkIncidentBreadcrumb, "timestamp"> & {
      timestamp?: string;
    },
  ): void {
    const maxBreadcrumbs = this.config?.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    const next: ChalkIncidentBreadcrumb = {
      timestamp: breadcrumb.timestamp ?? new Date().toISOString(),
      category: breadcrumb.category,
      message: breadcrumb.message,
      data: breadcrumb.data,
    };

    this.breadcrumbs.push(next);
    if (this.breadcrumbs.length > maxBreadcrumbs) {
      this.breadcrumbs = this.breadcrumbs.slice(-maxBreadcrumbs);
    }
  }

  emitErrorWithIncident(error: ChalkError, source: ChalkIncidentSource, details?: Record<string, unknown>): void {
    this.args.emitError(error);
    void this.reportIncident({
      source,
      severity: "error",
      message: error.message ?? "Unexpected error",
      code: typeof error.code === "string" ? error.code : String(error.code),
      stage: typeof error.details?.stage === "string" ? error.details.stage : typeof details?.stage === "string" ? details.stage : undefined,
      retryable: typeof error.details?.retryable === "boolean" ? error.details.retryable : typeof details?.retryable === "boolean" ? details.retryable : undefined,
      details: {
        ...(error.details ?? {}),
        ...(details ?? {}),
      },
    });
  }

  async reportIncident(incidentInput: ChalkIncidentInput): Promise<ChalkIncident | null> {
    if (!this.isEnabled()) {
      return null;
    }

    this.sequence += 1;

    const { roomId, localParticipantId } = this.args.getSnapshot();
    const maxBreadcrumbs = this.config?.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;

    const incident: ChalkIncident = {
      id: incidentInput.id ?? createSupportCode(this.sequence),
      timestamp: new Date().toISOString(),
      severity: incidentInput.severity ?? "error",
      source: incidentInput.source ?? "unknown",
      message: incidentInput.message,
      code: incidentInput.code,
      roomId,
      participantId: localParticipantId,
      traceId: wideEvents.sessionId,
      phase: incidentInput.phase,
      stage: incidentInput.stage,
      retryable: incidentInput.retryable,
      details: incidentInput.details,
      breadcrumbs: incidentInput.breadcrumbs ?? [...this.breadcrumbs].slice(-maxBreadcrumbs),
      context: {
        ...createBrowserIncidentContext(),
        ...(incidentInput.context ?? {}),
      },
    };

    const onIncident = this.config?.onIncident;
    if (onIncident) {
      try {
        onIncident(incident);
      } catch {
        // Keep incident pipeline non-blocking.
      }
    }

    const reporter = this.config?.reporter;
    if (reporter) {
      try {
        await reporter(incident);
      } catch (error) {
        this.recordBreadcrumb({
          category: "incident_reporter",
          message: "Incident reporter failed",
          data: {
            error: error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown reporter error",
          },
        });
      }
    }

    return incident;
  }

  private isEnabled(): boolean {
    if (!this.config) {
      return false;
    }
    if (typeof this.config.enabled === "boolean") {
      return this.config.enabled;
    }
    return Boolean(this.config.onIncident || this.config.reporter);
  }
}
