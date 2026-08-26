// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WhiteboardCanvas } from "./WhiteboardCanvas";

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => <div data-testid="excalidraw-canvas" />,
}));

describe("WhiteboardCanvas", () => {
  afterEach(() => {
    cleanup();
    document.getElementById("chalk-excalidraw-styles")?.remove();
  });

  it("shows a loading state while Excalidraw initializes", () => {
    render(<WhiteboardCanvas />);
    expect(screen.getByLabelText("Shared whiteboard").getAttribute("data-chalk-whiteboard-surface")).toBe("true");
    expect(screen.getByLabelText("Shared whiteboard").getAttribute("data-chalk-whiteboard-ready")).toBe("false");
    expect(screen.getByText("Loading whiteboard...")).toBeTruthy();
  });

  it("keeps caller layout classes authoritative", () => {
    const { container } = render(<WhiteboardCanvas className="hidden min-h-0 flex-none overflow-visible" />);
    const root = container.firstElementChild;

    expect(root?.className).toContain("hidden min-h-0 flex-none overflow-visible");
    expect(root?.getAttribute("style")).toBeNull();
  });

  it("keeps its layout mounted when hidden", () => {
    const { container } = render(<WhiteboardCanvas isVisible={false} />);
    expect(container.firstElementChild?.hasAttribute("hidden")).toBe(true);
  });

  it("does not fetch a runtime stylesheet by default", () => {
    render(<WhiteboardCanvas />);
    expect(document.getElementById("chalk-excalidraw-styles")).toBeNull();
  });

  it("loads an explicit stylesheet path for embedded renderers", () => {
    render(<WhiteboardCanvas excalidrawCssPath="data:text/css," />);
    const stylesheet = document.getElementById("chalk-excalidraw-styles");

    expect(stylesheet).toBeInstanceOf(HTMLLinkElement);
    expect(stylesheet?.getAttribute("href")).toBe("data:text/css,");
  });
});
