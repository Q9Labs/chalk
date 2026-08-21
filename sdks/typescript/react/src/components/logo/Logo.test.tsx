// @vitest-environment happy-dom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Logo } from "./Logo";

afterEach(cleanup);

describe("Logo", () => {
  it("renders the animated wordmark with the documented defaults", () => {
    const { container } = render(<Logo />);
    const logo = container.querySelector("svg");

    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("data-chalk-logo", "true");
    expect(logo).toHaveAttribute("data-chalk-logo-motion", "orbit-burst");
    expect(logo).toHaveAttribute("viewBox", "0 0 200 80");
    expect(logo).toHaveAttribute("height", "32");
    expect(logo).toHaveAttribute("width", "80");
    expect(logo).toHaveAttribute("color", "#1A332B");
    expect(logo).toHaveAttribute("role", "img");
    expect(logo).toHaveAttribute("aria-label", "Chalk");
    expect(logo?.querySelectorAll(".chalk-logo__stick")).toHaveLength(4);
  });

  it("supports a compact mark variant without the wordmark", () => {
    const { container } = render(<Logo variant="mark" height={40} />);
    const logo = container.querySelector("svg");

    expect(logo).toHaveAttribute("viewBox", "0 0 68 80");
    expect(logo).toHaveAttribute("height", "40");
    expect(logo).toHaveAttribute("width", "34");
    expect(logo?.querySelector("text")).not.toBeInTheDocument();
  });

  it("accepts custom dimensions, color, and motion mode", () => {
    const { container } = render(<Logo color="#123456" height={48} motion="none" />);
    const logo = container.querySelector("svg");

    expect(logo).toHaveAttribute("color", "#123456");
    expect(logo).toHaveAttribute("height", "48");
    expect(logo).toHaveAttribute("width", "120");
    expect(logo).toHaveAttribute("data-chalk-logo-motion", "none");
  });

  it("uses a custom accessibility label or becomes decorative when null", () => {
    const { container, rerender } = render(<Logo accessibilityLabel="Product logo" />);
    let logo = container.querySelector("svg");

    expect(logo).toHaveAttribute("role", "img");
    expect(logo).toHaveAttribute("aria-label", "Product logo");
    expect(logo).not.toHaveAttribute("aria-hidden");

    rerender(<Logo accessibilityLabel={null} />);
    logo = container.querySelector("svg");
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo).not.toHaveAttribute("aria-label");
    expect(logo).not.toHaveAttribute("role");
  });

  it("scopes gradient ids per instance", () => {
    const { container } = render(
      <>
        <Logo />
        <Logo />
      </>,
    );
    const gradients = Array.from(container.querySelectorAll("linearGradient"));
    const ids = gradients.map((gradient) => gradient.id);

    expect(gradients).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(ids.every((id) => id.startsWith("chalk-logo-"))).toBe(true);
  });

  it("keeps the wordmark static while wrapping each stick separately", () => {
    const { container } = render(<Logo />);
    const wordmark = container.querySelector(".chalk-logo__wordmark");
    const sticks = container.querySelectorAll(".chalk-logo__stick");

    expect(wordmark).toBeInTheDocument();
    expect(wordmark).toHaveClass("chalk-logo__wordmark");
    expect(wordmark).not.toHaveClass("chalk-logo__stick");
    expect(wordmark).not.toHaveClass("chalk-logo__stick--green");
    expect(wordmark?.closest(".chalk-logo__stick")).toBeNull();
    expect(sticks).toHaveLength(4);
    expect(Array.from(sticks).map((stick) => stick.getAttribute("class"))).toEqual(["chalk-logo__stick chalk-logo__stick--green", "chalk-logo__stick chalk-logo__stick--yellow", "chalk-logo__stick chalk-logo__stick--blue", "chalk-logo__stick chalk-logo__stick--pink"]);
  });
});
