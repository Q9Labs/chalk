// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BoardIsland } from "./BoardIsland";

afterEach(() => vi.unstubAllGlobals());

it.each(["bottom", "left"] as const)("has one Tab stop and roves with the keyboard when docked %s", async (place) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <BoardIsland
          tool="pen"
          shape="rectangle"
          onTool={() => undefined}
          color="ink"
          width="medium"
          onColor={() => undefined}
          onWidth={() => undefined}
          surface="chalkboard"
          theme="dark"
          canUndo={false}
          canRedo={false}
          onUndo={() => undefined}
          onRedo={() => undefined}
          place={place}
          onPlace={() => undefined}
          compact={false}
        />,
      ),
    );
    const toolbar = container.querySelector('[role="toolbar"]');
    if (!(toolbar instanceof HTMLElement)) throw new Error("Drawing toolbar is missing");
    const stops = () => [...toolbar.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.tabIndex === 0);
    expect(stops()).toHaveLength(1);
    const first = stops()[0];
    if (!first) throw new Error("Toolbar entry stop is missing");
    await act(async () => first.focus());
    const press = async (key: string) => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement)) throw new Error("Focus left the toolbar");
      await act(async () => focused.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
      expect(stops()).toHaveLength(1);
      expect(stops()[0]).toBe(document.activeElement);
    };
    await press(place === "left" ? "ArrowDown" : "ArrowRight");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Select");
    await press("End");
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Colour:/);
    await press(place === "left" ? "ArrowUp" : "ArrowLeft");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Laser pointer");
    await press("Home");
    expect(document.activeElement).toBe(first);
    expect(toolbar.querySelectorAll('button:disabled[tabindex="0"]')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
