// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WhiteboardView } from "./WhiteboardView";

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => <div data-testid="excalidraw-canvas" />,
}));

describe("WhiteboardView", () => {
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
    render(<WhiteboardView />);

    expect(screen.getByText("Loading whiteboard...")).toBeInTheDocument();
  });
});
