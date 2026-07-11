// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WhiteboardCanvas } from "./WhiteboardCanvas";

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => <div data-testid="excalidraw-canvas" />,
}));

describe("WhiteboardCanvas", () => {
  beforeEach(() => {
    const link = document.createElement("link");
    link.id = "chalk-excalidraw-styles";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  });

  afterEach(() => {
    cleanup();
    document.getElementById("chalk-excalidraw-styles")?.remove();
  });

  it("shows a loading state while Excalidraw initializes", () => {
    render(<WhiteboardCanvas />);
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
});
