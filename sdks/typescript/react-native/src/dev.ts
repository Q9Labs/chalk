/**
 * Development-only seams for a state harness and parity checks. Import this entry behind `__DEV__`
 * with `require`, so Metro drops it, and everything only it reaches, from release bundles.
 */
export { setDevScenario } from "./frame/dev-scenario";
export type { DevScenario } from "./frame/dev-scenario";
export type { AudioRoute, AudioRouteKind, AudioRoutes } from "./dock/audio-route";
export { setMeasurementRegistry } from "./frame/measurement";
export type { MeasuredFrame, Measurement, MeasurementRegistry } from "./frame/measurement";
