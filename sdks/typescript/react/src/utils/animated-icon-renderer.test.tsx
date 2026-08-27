// @vitest-environment happy-dom

import Calendar01Icon from "@hugeicons/core-free-icons/Calendar01Icon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import { Copy01Icon as BarrelCopy01Icon } from "@hugeicons/core-free-icons";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnimatedHugeiconsIcon } from "./animated-icon-renderer";

afterEach(cleanup);

describe("AnimatedHugeiconsIcon", () => {
  it("renders a mapped glyph through the animated collection", () => {
    const onClick = vi.fn();
    const view = render(<AnimatedHugeiconsIcon icon={Copy01Icon} size={18} className="copy-icon" aria-label="Copy" focusable="false" strokeWidth={1.8} onClick={onClick} />);

    const wrapper = view.container.querySelector('[data-hugeicons-animated="true"]');
    const svg = wrapper?.querySelector("svg");

    expect(wrapper).toHaveClass("copy-icon");
    expect(svg).toHaveAttribute("width", "18");
    expect(svg).toHaveAttribute("height", "18");
    expect(svg).toHaveAttribute("aria-label", "Copy");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveAttribute("stroke-width", "1.8");
    expect(svg?.querySelector('path[stroke-width="inherit"]')).toBeInTheDocument();

    if (svg) fireEvent.click(svg);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("matches equivalent glyphs from the package barrel and keeps Hugeicons sizing semantics", () => {
    const view = render(<AnimatedHugeiconsIcon icon={BarrelCopy01Icon} absoluteStrokeWidth strokeWidth={2} size={48} />);
    const wrapper = view.container.querySelector('[data-hugeicons-animated="true"]');
    const svg = wrapper?.querySelector("svg");

    expect(wrapper).toBeInTheDocument();
    expect(svg).toHaveAttribute("width", "48");
    expect(svg).toHaveAttribute("stroke-width", "1");
  });

  it("uses the 24px Hugeicons default size", () => {
    const view = render(<AnimatedHugeiconsIcon icon={Copy01Icon} />);
    const svg = view.container.querySelector("svg");

    expect(svg).toHaveAttribute("width", "24");
    expect(svg).toHaveAttribute("height", "24");
  });

  it("keeps the Hugeicons renderer for glyphs without an animation", () => {
    const view = render(<AnimatedHugeiconsIcon icon={Calendar01Icon} size={20} aria-label="Calendar" />);

    expect(view.container.querySelector('[data-hugeicons-animated="true"]')).not.toBeInTheDocument();
    expect(view.getByLabelText("Calendar")).toHaveAttribute("width", "20");
  });
});
