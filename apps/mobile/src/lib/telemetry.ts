import { createJourneyIntakeExporter, createTelemetryClient, type TelemetryClient } from "@q9labsai/chalk-client/telemetry";

export interface MobileTelemetryOptions {
  readonly apiUrl: string;
  readonly enabled: boolean;
  readonly tokenProvider?: () => Promise<string>;
}

/** Mobile keeps an explicitly bounded in-memory fallback until a platform queue adapter is supplied by the host app. */
export function createMobileTelemetry({ apiUrl, enabled, tokenProvider }: MobileTelemetryOptions): TelemetryClient {
  if (!tokenProvider) {
    return createTelemetryClient({ enabled, maxQueueSize: 100 });
  }

  return createTelemetryClient({
    enabled,
    exporter: createJourneyIntakeExporter({
      baseUrl: apiUrl,
      headers: async () => ({ Authorization: `Bearer ${await tokenProvider()}` }),
      path: "/v1/telemetry/journey-events",
    }),
    maxQueueSize: 100,
  });
}

export async function flushAndDisposeTelemetry(telemetry: Pick<TelemetryClient, "dispose" | "flush">): Promise<void> {
  try {
    await telemetry.flush();
  } finally {
    telemetry.dispose();
  }
}
