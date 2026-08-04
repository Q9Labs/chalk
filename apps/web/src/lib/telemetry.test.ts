import { afterEach, describe, expect, it, vi } from "vitest";

const telemetryModule = vi.hoisted(() => ({
  createBrowserRuntimeTelemetryStorage: vi.fn(),
  createTelemetryClient: vi.fn((options: { readonly enabled?: boolean }) => ({ enabled: options.enabled ?? false, flush: vi.fn(async () => undefined) })),
}));

vi.mock("@q9labsai/chalk-client/telemetry", () => telemetryModule);

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("webTelemetry", () => {
  it("does not construct the Effect runtime during server module evaluation", async () => {
    await import("./telemetry");

    expect(telemetryModule.createTelemetryClient).not.toHaveBeenCalled();
  });

  it("is inert without explicit telemetry opt-in", async () => {
    const { createWebTelemetry } = await import("./telemetry");
    const webTelemetry = createWebTelemetry();

    expect(webTelemetry.enabled).toBe(false);
  });

  it("stays inert during server rendering even when telemetry is opted in", async () => {
    vi.stubEnv("VITE_CHALK_TELEMETRY_ENABLED", "true");

    const { createWebTelemetry } = await import("./telemetry");
    const webTelemetry = createWebTelemetry();

    expect(webTelemetry.enabled).toBe(false);
    expect(telemetryModule.createTelemetryClient).not.toHaveBeenCalled();
    await expect(webTelemetry.flush()).resolves.toBeUndefined();
  });

  it("uses a runtime-scoped durable queue for an enabled deployment", async () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("VITE_CHALK_TELEMETRY_ENABLED", "true");

    const { createWebTelemetry } = await import("./telemetry");
    createWebTelemetry();

    expect(telemetryModule.createBrowserRuntimeTelemetryStorage).toHaveBeenCalledWith("chalk.web.telemetry.v1");
  });

  it("keeps configured journey export unavailable until Wave 6 supplies API authentication", async () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("VITE_CHALK_TELEMETRY_ENABLED", "true");
    const { createWebTelemetry } = await import("./telemetry");
    const webTelemetry = createWebTelemetry();

    webTelemetry.configureApiBaseURL("https://api.chalk.test/control?ignored=true");
    expect(telemetryModule.createTelemetryClient).toHaveBeenCalledWith(expect.objectContaining({ exporter: expect.any(Function) }));
  });

  it("rejects a pre-credential export promptly and retriably so lifecycle flushes stay bounded", async () => {
    const { createDeferredJourneyExporter, JourneyTelemetryAuthenticationUnavailableError } = await import("./telemetry");

    const deferred = createDeferredJourneyExporter();
    await expect(deferred.exporter([])).rejects.toMatchObject({ message: "Journey telemetry endpoint is not ready." });

    deferred.configureApiBaseURL("https://api.chalk.test");
    await expect(deferred.exporter([])).rejects.toBeInstanceOf(JourneyTelemetryAuthenticationUnavailableError);
  });
});
