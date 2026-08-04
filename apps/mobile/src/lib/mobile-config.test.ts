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

import { getBrokerUrl, getMobileRuntimeConfig, isMobileTelemetryEnabled } from "./mobile-config";

const defaultBrokerUrl = "https://chalkmeet.com/local-chalk";

describe("mobile runtime config", () => {
  beforeEach(() => {
    expoConstants.expoConfig = null;
    runtime.getReactNativeScriptUrl.mockClear();
    runtime.resolveAppRuntimeUrl.mockClear();
  });

  it("defaults to the production broker and telemetry off when extra is absent", () => {
    expect(getMobileRuntimeConfig()).toEqual({ brokerUrl: defaultBrokerUrl, telemetryEnabled: false });
    expect(getBrokerUrl()).toBe(defaultBrokerUrl);
    expect(isMobileTelemetryEnabled()).toBe(false);
  });

  it("uses the validated broker override and explicit telemetry opt-in from extra", () => {
    expoConstants.expoConfig = { extra: { brokerUrl: "http://127.0.0.1:8787/local-chalk", telemetryEnabled: true } };

    expect(getMobileRuntimeConfig()).toEqual({ brokerUrl: "http://127.0.0.1:8787/local-chalk", telemetryEnabled: true });
  });

  it.each(["not-a-url", "ftp://chalkmeet.com/local-chalk", "https://user:password@chalkmeet.com/local-chalk"])("falls back for an invalid broker override (%s)", (brokerUrl) => {
    expoConstants.expoConfig = { extra: { brokerUrl, telemetryEnabled: "true" } };

    expect(getMobileRuntimeConfig()).toEqual({ brokerUrl: defaultBrokerUrl, telemetryEnabled: false });
  });
});
