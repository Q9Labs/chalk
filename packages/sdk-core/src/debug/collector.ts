import type { ChalkIncident, ChalkIncidentBreadcrumb } from "../incident.ts";
import type { WideEvent } from "../wide-events/index.ts";
import type { ChalkDebugConsoleRecord, ChalkDebugFetchRecord, ChalkDebugRuntimeErrorRecord, ChalkDebugSnapshot, ChalkDebugWebSocketRecord } from "./types.ts";

type Provider = () => unknown;

const LIMITS = {
  fetch: 300,
  websocket: 600,
  console: 600,
  runtimeErrors: 200,
  wideEvents: 400,
  incidents: 120,
  breadcrumbs: 400,
} as const;

const pushBounded = <T>(items: T[], next: T, limit: number) => {
  items.push(next);
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
};

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export class ChalkDebugCollector {
  private readonly fetchRecords: ChalkDebugFetchRecord[] = [];
  private readonly websocketRecords: ChalkDebugWebSocketRecord[] = [];
  private readonly consoleRecords: ChalkDebugConsoleRecord[] = [];
  private readonly runtimeErrorRecords: ChalkDebugRuntimeErrorRecord[] = [];
  private readonly wideEventRecords: WideEvent[] = [];
  private readonly incidentRecords: ChalkIncident[] = [];
  private readonly breadcrumbRecords: ChalkIncidentBreadcrumb[] = [];
  private readonly providers = new Map<string, Provider>();

  nextId(): string {
    return createId();
  }

  recordFetch(record: ChalkDebugFetchRecord): void {
    pushBounded(this.fetchRecords, record, LIMITS.fetch);
  }

  recordWebSocket(record: ChalkDebugWebSocketRecord): void {
    pushBounded(this.websocketRecords, record, LIMITS.websocket);
  }

  recordConsole(record: ChalkDebugConsoleRecord): void {
    pushBounded(this.consoleRecords, record, LIMITS.console);
  }

  recordRuntimeError(record: ChalkDebugRuntimeErrorRecord): void {
    pushBounded(this.runtimeErrorRecords, record, LIMITS.runtimeErrors);
  }

  recordWideEvent(event: WideEvent): void {
    pushBounded(this.wideEventRecords, event, LIMITS.wideEvents);
  }

  recordIncident(incident: ChalkIncident): void {
    pushBounded(this.incidentRecords, incident, LIMITS.incidents);
  }

  recordBreadcrumb(breadcrumb: ChalkIncidentBreadcrumb): void {
    pushBounded(this.breadcrumbRecords, breadcrumb, LIMITS.breadcrumbs);
  }

  registerSection(name: string, provider: Provider): () => void {
    this.providers.set(name, provider);
    return () => {
      this.providers.delete(name);
    };
  }

  getSnapshot(): ChalkDebugSnapshot {
    const sections = Object.fromEntries(
      [...this.providers.entries()].map(([name, provider]) => {
        try {
          return [name, provider()];
        } catch (error) {
          return [
            name,
            {
              error: error instanceof Error ? error.message : String(error),
            },
          ];
        }
      }),
    );

    return {
      generatedAt: new Date().toISOString(),
      fetch: [...this.fetchRecords],
      websocket: [...this.websocketRecords],
      console: [...this.consoleRecords],
      runtimeErrors: [...this.runtimeErrorRecords],
      wideEvents: [...this.wideEventRecords],
      incidents: [...this.incidentRecords],
      breadcrumbs: [...this.breadcrumbRecords],
      sections,
    };
  }

  reset(): void {
    this.fetchRecords.length = 0;
    this.websocketRecords.length = 0;
    this.consoleRecords.length = 0;
    this.runtimeErrorRecords.length = 0;
    this.wideEventRecords.length = 0;
    this.incidentRecords.length = 0;
    this.breadcrumbRecords.length = 0;
    this.providers.clear();
  }
}

export const chalkDebugCollector = new ChalkDebugCollector();
