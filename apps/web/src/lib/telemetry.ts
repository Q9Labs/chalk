import { createBrowserRuntimeTelemetryStorage, createTelemetryClient } from "@q9labsai/chalk-client/telemetry";

const apiBaseUrl = import.meta.env.VITE_CHALK_API_URL;
const telemetryEnabled = import.meta.env.VITE_CHALK_TELEMETRY_ENABLED === "true" && apiBaseUrl !== undefined;

/** Web telemetry requires an explicit authenticated API deployment; public pages remain inert. */
export const webTelemetry = createTelemetryClient({
  enabled: telemetryEnabled,
  ...(apiBaseUrl
    ? {
        baseUrl: apiBaseUrl,
        credentials: "include",
        storage: createBrowserRuntimeTelemetryStorage("chalk.web.telemetry.v1"),
      }
    : {}),
  maxQueueSize: 100,
});
