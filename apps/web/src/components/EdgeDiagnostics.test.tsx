// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EdgeDiagnostics } from "./EdgeDiagnostics";

vi.mock("../lib/webMeeting", () => ({
  getApiUrl: () => "http://localhost:8080",
}));

const canvasContext = {
  arc: vi.fn(),
  beginPath: vi.fn(),
  clearRect: vi.fn(),
  closePath: vi.fn(),
  fill: vi.fn(),
  fillText: vi.fn(),
  lineTo: vi.fn(),
  moveTo: vi.fn(),
  resetTransform: vi.fn(),
  scale: vi.fn(),
  setLineDash: vi.fn(),
  stroke: vi.fn(),
} as unknown as CanvasRenderingContext2D;

describe("EdgeDiagnostics", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(canvasContext);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders diagnostic tabs for network, media, and simulation checks", () => {
    render(<EdgeDiagnostics />);

    expect(screen.getByText("Diagnostics & Latency")).toBeDefined();
    expect(screen.getByText("Chalk API RTT")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "media" }));
    expect(screen.getByText("Chalk Engine WebRTC Codec Support Matrix")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "WebRTC Simulator" }));
    expect(screen.getByText("Adaptive WebRTC Network Simulator")).toBeDefined();
    expect(screen.getByText("Chalk RTC Engine Decisions Log")).toBeDefined();
  });
});
