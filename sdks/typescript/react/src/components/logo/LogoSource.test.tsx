// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LogoSource } from "./LogoSource";

afterEach(cleanup);

describe("LogoSource", () => {
  it("uses the animated SDK logo when no URL is supplied", () => {
    render(<LogoSource height={32} />);

    expect(screen.getByRole("img", { name: "Chalk" })).toHaveAttribute("data-chalk-logo-motion", "orbit-burst");
  });

  it("recognizes canonical light and dark Chalk URLs", () => {
    const { rerender } = render(<LogoSource height={28} logoUrl="/brand/chalk/chalk-logo.svg" />);
    let logo = screen.getByRole("img", { name: "Chalk" });

    expect(logo).toHaveAttribute("data-chalk-logo", "true");
    expect(logo).toHaveAttribute("color", "currentColor");

    rerender(<LogoSource height={28} logoUrl="/brand/chalk/chalk-logo-on-dark.svg" />);
    logo = screen.getByRole("img", { name: "Chalk" });
    expect(logo).toHaveAttribute("color", "#F4F3EE");
  });

  it("keeps a customer logo URL as a static image", () => {
    render(<LogoSource className="customer-logo" height={28} logoUrl="https://cdn.example.com/customer.svg" />);

    const logo = screen.getByRole("img", { name: "Chalk" });
    expect(logo).toHaveAttribute("src", "https://cdn.example.com/customer.svg");
    expect(logo).toHaveClass("customer-logo");
    expect(logo).not.toHaveAttribute("data-chalk-logo");
  });
});
