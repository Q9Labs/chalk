import { beforeEach, describe, expect, it, vi } from "vitest";

const expoConstants = vi.hoisted(() => ({
  expoConfig: null as { readonly extra?: unknown } | null,
}));
const runtime = vi.hoisted(() => ({
  getReactNativeScriptUrl: vi.fn<() => string | null>(() => null),
  resolveAppRuntimeUrl: vi.fn(({ configuredUrl, fallbackUrl }: { readonly configuredUrl?: string; readonly fallbackUrl: string }) => configuredUrl ?? fallbackUrl),
}));

vi.mock("expo-constants", () => ({ default: expoConstants }));
vi.mock("@q9labsai/chalk-react-native/runtime", () => runtime);

import { getApiBaseURL, getMobileRuntimeConfig, isMobileTelemetryEnabled } from "./mobile-config";

const defaultApiBaseURL = "https://api.chalkmeet.com";

describe("mobile runtime config", () => {
  beforeEach(() => {
    expoConstants.expoConfig = null;
    runtime.getReactNativeScriptUrl.mockClear();
    runtime.resolveAppRuntimeUrl.mockClear();
  });

  it("defaults to the production public-invite API and telemetry off when extra is absent", () => {
    expect(getMobileRuntimeConfig()).toEqual({ apiBaseURL: defaultApiBaseURL, telemetryEnabled: false });
    expect(getApiBaseURL()).toBe(defaultApiBaseURL);
    expect(isMobileTelemetryEnabled()).toBe(false);
  });

  it("uses the validated API override and explicit telemetry opt-in from extra", () => {
    expoConstants.expoConfig = { extra: { apiBaseURL: "http://127.0.0.1:8787", telemetryEnabled: true } };

    expect(getMobileRuntimeConfig()).toEqual({ apiBaseURL: "http://127.0.0.1:8787", telemetryEnabled: true });
  });

  it.each(["not-a-url", "ftp://chalkmeet.com", "https://user:password@chalkmeet.com"])("falls back for an invalid API override (%s)", (apiBaseURL) => {
    expoConstants.expoConfig = { extra: { apiBaseURL, telemetryEnabled: "true" } };

    expect(getMobileRuntimeConfig()).toEqual({ apiBaseURL: defaultApiBaseURL, telemetryEnabled: false });
  });
});
