import { afterEach, describe, expect, it, vi } from "vitest";

const telemetryModule = vi.hoisted(() => ({
  createBrowserRuntimeTelemetryStorage: vi.fn(),
  createTelemetryClient: vi.fn((options: { readonly enabled?: boolean }) => ({ enabled: options.enabled ?? false })),
}));

vi.mock("@q9labsai/chalk-client/telemetry", () => telemetryModule);

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("webTelemetry", () => {
  it("does not construct the Effect runtime during server module evaluation", async () => {
    await import("./telemetry");

    expect(telemetryModule.createTelemetryClient).not.toHaveBeenCalled();
  });

  it("is inert without an explicitly enabled authenticated API deployment", async () => {
    const { createWebTelemetry } = await import("./telemetry");
    const webTelemetry = createWebTelemetry();

    expect(webTelemetry.enabled).toBe(false);
  });

  it("uses a runtime-scoped durable queue for an enabled deployment", async () => {
    vi.stubEnv("VITE_CHALK_API_URL", "https://api.chalk.test");
    vi.stubEnv("VITE_CHALK_TELEMETRY_ENABLED", "true");

    const { createWebTelemetry } = await import("./telemetry");
    createWebTelemetry();

    expect(telemetryModule.createBrowserRuntimeTelemetryStorage).toHaveBeenCalledWith("chalk.web.telemetry.v1");
  });
});
