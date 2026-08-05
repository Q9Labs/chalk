/* @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const journey = {};
  const telemetry = { configureApiBaseURL: vi.fn(), startJourney: vi.fn(() => journey), flush: vi.fn() };
  const uninstall = vi.fn();
  return {
    journey,
    telemetry,
    uninstall,
    createWebTelemetry: vi.fn(() => telemetry),
    installWebTelemetryLifecycle: vi.fn(() => uninstall),
  };
});

vi.mock("./telemetry", () => ({ createWebTelemetry: mocks.createWebTelemetry }));
vi.mock("./telemetryLifecycle", () => ({ installWebTelemetryLifecycle: mocks.installWebTelemetryLifecycle }));

import { WebTelemetryProvider, useWebTelemetry } from "./web-telemetry-context";

afterEach(() => {
  vi.clearAllMocks();
});

describe("WebTelemetryProvider", () => {
  it("provides the lifecycle-owned page journey to Space descendants", () => {
    const view = render(
      <WebTelemetryProvider>
        <JourneyConsumer />
      </WebTelemetryProvider>,
    );

    expect(mocks.telemetry.startJourney).toHaveBeenCalledWith({ kind: "web.application" });
    expect(mocks.installWebTelemetryLifecycle).toHaveBeenCalledWith(mocks.telemetry, mocks.journey);
    expect(screen.getByTestId("journey").textContent).toBe("shared");
    expect(mocks.telemetry.configureApiBaseURL).toHaveBeenCalledWith("https://api.chalk.test");

    view.unmount();
    expect(mocks.uninstall).toHaveBeenCalledTimes(1);
  });
});

function JourneyConsumer() {
  const { journey, telemetry } = useWebTelemetry();
  useEffect(() => telemetry.configureApiBaseURL("https://api.chalk.test"), [telemetry]);
  return <output data-testid="journey">{journey === mocks.journey ? "shared" : "separate"}</output>;
}
