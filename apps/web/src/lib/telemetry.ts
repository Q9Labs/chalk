import { createBrowserRuntimeTelemetryStorage, createTelemetryClient, type StartJourneyOptions, type TelemetryClient, type TelemetryExporter, type TelemetryJourney } from "@q9labsai/chalk-client/telemetry";

const telemetryEnabled = import.meta.env.VITE_CHALK_TELEMETRY_ENABLED === "true";

export type WebTelemetryJourney = Pick<TelemetryJourney, "headers" | "recordDiagnostic" | "recordHttpRequest"> & {
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
 * The browser broker intentionally exposes neither: its AccessGrant is opaque
 * and its HttpOnly credential is scoped to broker routes. Wave 6 must provide
 * an authenticated intake relay or an explicit bearer provider here.
 */
export class JourneyTelemetryAuthenticationUnavailableError extends Error {
  constructor() {
    super("Journey telemetry authentication is not available in the web surface yet.");
    this.name = "JourneyTelemetryAuthenticationUnavailableError";
  }
}

/** Telemetry is explicitly opt-in; the broker chooses the only permitted export origin after identity arrival. */
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
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("The broker returned an invalid telemetry API origin.");
  if (url.username || url.password) throw new TypeError("The broker returned an invalid telemetry API origin.");
  return url.origin;
}
