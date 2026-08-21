import { createBrowserRuntimeTelemetryStorage, createTelemetryClient, type StartJourneyOptions, type TelemetryClient, type TelemetryExporter, type TelemetryJourney } from "@q9labsai/chalk-client/telemetry";

const telemetryEnabled = import.meta.env.VITE_CHALK_TELEMETRY_ENABLED === "true";

export type WebTelemetryJourney = Pick<TelemetryJourney, "headers" | "recordDiagnostic" | "recordHttpRequest"> & {
  readonly context?: TelemetryJourney["context"];
  readonly terminal: (...args: Parameters<TelemetryJourney["terminal"]>) => void;
};

export type WebTelemetry = Pick<TelemetryClient, "enabled" | "flush"> & {
  readonly startJourney: (options: StartJourneyOptions) => WebTelemetryJourney;
  readonly configureApiBaseURL: (apiBaseURL: string) => void;
};

type DeferredJourneyExporter = {
  readonly configureApiBaseURL: (apiBaseURL: string) => void;
  readonly exporter: TelemetryExporter;
};

type JourneyExporterFactory = (apiBaseURL: string) => TelemetryExporter;

/**
 * The API intake route requires an authenticated user credential or provider bearer.
 * Public Space arrivals expose only an opaque AccessGrant and a per-arrival
 * HttpOnly guest cookie, so the web surface cannot export until an authenticated
 * intake relay or explicit bearer provider is available.
 */
export class JourneyTelemetryAuthenticationUnavailableError extends Error {
  constructor() {
    super("Journey telemetry cannot authenticate against the API in this web surface yet.");
    this.name = "JourneyTelemetryAuthenticationUnavailableError";
  }
}

/** Telemetry is explicitly opt-in; the API origin is configured after Space access is established. */
export function createWebTelemetry(): WebTelemetry {
  if (typeof window === "undefined") return createServerWebTelemetry();

  const deferredExporter = telemetryEnabled ? createDeferredJourneyExporter() : undefined;
  const telemetry = createTelemetryClient({
    enabled: telemetryEnabled,
    ...(deferredExporter
      ? {
          exporter: deferredExporter.exporter,
          storage: createBrowserRuntimeTelemetryStorage("chalk.web.telemetry.v1"),
        }
      : {}),
    maxQueueSize: 100,
  });
  return Object.assign(telemetry, {
    configureApiBaseURL: (apiBaseURL: string) => {
      deferredExporter?.configureApiBaseURL(apiBaseURL);
      if (deferredExporter) void telemetry.flush().catch(() => undefined);
    },
  });
}

function createServerWebTelemetry(): WebTelemetry {
  return {
    enabled: false,
    configureApiBaseURL: () => undefined,
    flush: async () => undefined,
    startJourney: () => ({
      headers: {},
      recordDiagnostic: () => undefined,
      recordHttpRequest: () => undefined,
      terminal: () => undefined,
    }),
  };
}

export function createDeferredJourneyExporter(createExporter: JourneyExporterFactory = unavailableJourneyExporter): DeferredJourneyExporter {
  let configuredExporter: TelemetryExporter | undefined;
  let configuredOrigin: string | undefined;

  return {
    configureApiBaseURL(apiBaseURL) {
      const origin = telemetryOrigin(apiBaseURL);
      if (configuredOrigin === origin) return;
      if (configuredOrigin) throw new Error("The telemetry export origin cannot change during a page journey.");
      configuredOrigin = origin;
      configuredExporter = createExporter(origin);
    },
    async exporter(events, options) {
      if (!configuredExporter) throw new Error("Journey telemetry endpoint is not ready.");
      return configuredExporter!(events, options);
    },
  };
}

function unavailableJourneyExporter(_apiBaseURL: string): TelemetryExporter {
  return async () => {
    throw new JourneyTelemetryAuthenticationUnavailableError();
  };
}

function telemetryOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("The API returned an invalid telemetry origin.");
  if (url.username || url.password) throw new TypeError("The API returned an invalid telemetry origin.");
  return url.origin;
}
