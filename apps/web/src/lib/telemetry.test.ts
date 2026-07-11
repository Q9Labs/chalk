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
  it("is inert without an explicitly enabled authenticated API deployment", async () => {
    const { webTelemetry } = await import("./telemetry");

    expect(webTelemetry.enabled).toBe(false);
  });

  it("uses a runtime-scoped durable queue for an enabled deployment", async () => {
    vi.stubEnv("VITE_CHALK_API_URL", "https://api.chalk.test");
    vi.stubEnv("VITE_CHALK_TELEMETRY_ENABLED", "true");

    await import("./telemetry");

    expect(telemetryModule.createBrowserRuntimeTelemetryStorage).toHaveBeenCalledWith("chalk.web.telemetry.v1");
  });
});
