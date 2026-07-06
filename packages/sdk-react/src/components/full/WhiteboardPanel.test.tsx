// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WhiteboardPanel } from "./WhiteboardPanel";

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => <div data-testid="excalidraw-canvas" />,
}));

describe("WhiteboardPanel", () => {
  beforeEach(() => {
    const link = document.createElement("link");
    link.id = "chalk-excalidraw-styles";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  });

  afterEach(() => {
    document.getElementById("chalk-excalidraw-styles")?.remove();
  });

  it("shows the loading state while whiteboard assets initialize", () => {
    render(<WhiteboardPanel />);

    expect(screen.getByText("Loading whiteboard...")).toBeInTheDocument();
  });
});
