import AsyncStorage from "@react-native-async-storage/async-storage";
import { createJourneyIntakeExporter, createKeyValueTelemetryStorage, createTelemetryClient, type TelemetryClient, type TelemetryExporter } from "@q9labsai/chalk-client/telemetry";

const AUTHENTICATED_EXPORT_DEPENDENCY_ERROR = "Journey telemetry export requires an SDK-owned verified Cloudflare participant bearer.";

export interface MobileTelemetryOptions {
  readonly enabled: boolean;
  readonly fetch?: typeof globalThis.fetch;
  /** The broker chooses the API origin with the participant credential. */
  readonly getApiBaseURL: () => string | undefined;
  /**
   * Wave 6 SDK-owned bridge for the verified Cloudflare participant bearer accepted by
   * `/v1/telemetry/journey-events`. The mobile app must not derive this from
   * the intentionally opaque AccessGrant.
   */
  readonly getAuthenticatedTelemetryHeaders?: () => Readonly<Record<string, string>> | undefined | Promise<Readonly<Record<string, string>> | undefined>;
}

export function createMobileTelemetry({ enabled, fetch, getApiBaseURL, getAuthenticatedTelemetryHeaders }: MobileTelemetryOptions): TelemetryClient {
  return createTelemetryClient({
    enabled,
    exporter: mobileJourneyExporter({ fetch, getApiBaseURL, getAuthenticatedTelemetryHeaders }),
    maxQueueSize: 100,
    storage: createKeyValueTelemetryStorage(AsyncStorage, "chalk.mobile.telemetry.v1"),
  });
}

export async function flushAndDisposeTelemetry(telemetry: Pick<TelemetryClient, "dispose" | "flush">): Promise<void> {
  try {
    await telemetry.flush();
  } finally {
    telemetry.dispose();
  }
}

function mobileJourneyExporter({ fetch, getApiBaseURL, getAuthenticatedTelemetryHeaders }: Pick<MobileTelemetryOptions, "fetch" | "getApiBaseURL" | "getAuthenticatedTelemetryHeaders">): TelemetryExporter {
  let exporter: TelemetryExporter | undefined;

  return async (events, options) => {
    if (!exporter) {
      const baseUrl = getApiBaseURL();
      if (!baseUrl) throw new Error("Journey telemetry endpoint is not ready.");
      if (!getAuthenticatedTelemetryHeaders) throw new Error(AUTHENTICATED_EXPORT_DEPENDENCY_ERROR);
      exporter = createJourneyIntakeExporter({
        baseUrl,
        fetch,
        headers: async () => {
          const headers = await getAuthenticatedTelemetryHeaders();
          if (!hasAuthenticatedParticipantBearer(headers)) throw new Error(AUTHENTICATED_EXPORT_DEPENDENCY_ERROR);
          return headers;
        },
      });
    }
    return exporter(events, options);
  };
}

function hasAuthenticatedParticipantBearer(headers: Readonly<Record<string, string>> | undefined): headers is Readonly<Record<string, string>> {
  const authorization = Object.entries(headers ?? {})
    .find(([name]) => name.toLowerCase() === "authorization")?.[1]
    ?.trim();
  return authorization !== undefined && /^bearer\s+\S+/iu.test(authorization);
}
