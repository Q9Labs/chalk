// @vitest-environment happy-dom

import Calendar01Icon from "@hugeicons/core-free-icons/Calendar01Icon";
import CopyGlyph from "@hugeicons/core-free-icons/Copy01Icon";
import { Copy01Icon as BarrelCopy01Icon } from "@hugeicons/core-free-icons";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnimatedHugeiconsIcon } from "./animated-icon-renderer";
import { Copy01Icon } from "./animated-icons";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(element: ReactNode) {
  act(() => root.render(element));
}

describe("animated Hugeicons boundary", () => {
  it("preserves mapped and fallback Hugeicons semantics", () => {
    const onClick = vi.fn();
    render(<AnimatedHugeiconsIcon icon={CopyGlyph} size={18} className="copy-icon" aria-label="Copy" focusable="false" strokeWidth={1.8} onClick={onClick} />);

    const wrapper = container.querySelector('[data-hugeicons-animated="true"]');
    const svg = wrapper?.querySelector("svg");
    expect(wrapper?.classList.contains("copy-icon")).toBe(true);
    expect(svg?.getAttribute("width")).toBe("18");
    expect(svg?.getAttribute("aria-label")).toBe("Copy");
    expect(svg?.getAttribute("stroke-width")).toBe("1.8");
    expect(svg?.querySelector('path[stroke-width="inherit"]')).not.toBeNull();

    svg?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClick).toHaveBeenCalledOnce();

    render(<AnimatedHugeiconsIcon icon={Calendar01Icon} size={20} aria-label="Calendar" />);
    expect(container.querySelector('[data-hugeicons-animated="true"]')).toBeNull();
    expect(container.querySelector('svg[aria-label="Calendar"]')?.getAttribute("width")).toBe("20");
  });

  it("matches barrel glyphs and keeps Hugeicons size and stroke rules", () => {
    render(<AnimatedHugeiconsIcon icon={BarrelCopy01Icon} absoluteStrokeWidth strokeWidth={2} size={48} />);
    expect(container.querySelector('[data-hugeicons-animated="true"]')).not.toBeNull();
    expect(container.querySelector("svg")?.getAttribute("stroke-width")).toBe("1");

    render(<AnimatedHugeiconsIcon icon={CopyGlyph} />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("24");
  });

  it("starts and stops a nested animation with its parent control", () => {
    const onMouseEnter = vi.fn();
    const onMouseLeave = vi.fn();
    render(
      <button type="button">
        Copy
        <Copy01Icon aria-hidden="true" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} />
      </button>,
    );

    const button = container.querySelector("button");
    button?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    button?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));

    expect(onMouseEnter).toHaveBeenCalled();
    expect(onMouseLeave).toHaveBeenCalled();
  });
});
