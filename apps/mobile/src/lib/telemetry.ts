import AsyncStorage from "@react-native-async-storage/async-storage";
import { createJourneyIntakeExporter, createKeyValueTelemetryStorage, createTelemetryClient, type TelemetryClient } from "@q9labsai/chalk-client/telemetry";

export interface MobileTelemetryOptions {
  readonly enabled: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly getAccess?: () =>
    | {
        readonly apiBaseURL: string;
        readonly token: string;
      }
    | undefined;
}

export function createMobileTelemetry({ enabled, fetch, getAccess }: MobileTelemetryOptions): TelemetryClient {
  return createTelemetryClient({
    enabled,
    maxQueueSize: 100,
    storage: createKeyValueTelemetryStorage(AsyncStorage, "chalk.mobile.telemetry.v1"),
    ...(getAccess
      ? {
          exporter: async (events, options) => {
            const access = getAccess();
            if (!access) throw new Error("Participant telemetry access is not ready.");
            return createJourneyIntakeExporter({
              baseUrl: access.apiBaseURL,
              fetch,
              headers: { authorization: `Bearer ${access.token}` },
            })(events, options);
          },
        }
      : {}),
  });
}

export async function flushAndDisposeTelemetry(telemetry: Pick<TelemetryClient, "dispose" | "flush">): Promise<void> {
  try {
    await telemetry.flush();
  } finally {
    telemetry.dispose();
  }
}
