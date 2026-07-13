export {
  TelemetryDeliveryService,
  TelemetryExporterService,
  TelemetryExportFailure,
  TelemetryStorageFailure,
  TelemetryStorageService,
  makeFakeTelemetryExporterLayer,
  makeFakeTelemetryStorageLayer,
  makeTelemetryDeliveryLayer,
  makeTelemetryExporterLayer,
  makeTelemetryStorageLayer,
} from "./telemetry/delivery";
export { TelemetryEventSourceService, makeTelemetryEventSourceLayer } from "./telemetry/random";
export type { TelemetryDeliveryOptions, TelemetryExporterHealth, TelemetryTimelineEntry } from "./telemetry/delivery";
export type { TelemetryEventSource } from "./telemetry/random";
