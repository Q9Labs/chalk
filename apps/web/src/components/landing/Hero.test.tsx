/* @vitest-environment jsdom */

import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Hero, resolveSpaceInviteLink, SiteNav } from "./Hero";

describe("SiteNav", () => {
  it("exposes product anchors and production account actions", () => {
    const markup = renderToStaticMarkup(<SiteNav />);

    expect(markup).toContain('href="#product"');
    expect(markup).toContain('href="#performance"');
    expect(markup).toContain('href="#self-host"');
    expect(markup).toContain('href="#features"');
    expect(markup).toContain('href="/home"');
    expect(markup).toContain('href="/sign-in"');
    expect(markup).toContain('href="/sign-up"');
    expect(markup).not.toContain("import.meta.env.DEV");
  });
});

describe("Hero", () => {
  it("frames Chalk as the collaboration product and uses local technology marks", () => {
    const markup = renderToStaticMarkup(<Hero />);

    expect(markup).toContain("Bring people together.");
    expect(markup).toContain("dependable Space");
    expect(markup).toContain("Create an Account");
    expect(markup).toContain("Open Dashboard");
    expect(markup).toContain('id="join-space"');
    expect(markup).toContain('aria-label="TypeScript"');
    expect(markup).toContain('aria-label="React Native"');
    expect(markup).toContain("/brand/technology/typescript.svg");
    expect(markup).toContain("/brand/technology/react_light.svg");
    expect(markup).toContain("/brand/technology/cloudflare.svg");
    expect(markup).not.toContain("<svg");
  });
});

describe("resolveSpaceInviteLink", () => {
  const origin = "https://chalk.test";

  it("accepts Space paths and preserves hash invite tokens", () => {
    expect(resolveSpaceInviteLink(" /space/design-lab#spaceInviteToken=opaque-token ", origin)).toBe("https://chalk.test/space/design-lab#spaceInviteToken=opaque-token");
    expect(resolveSpaceInviteLink("https://other.example/space/design-lab#token", origin)).toBe("https://other.example/space/design-lab#token");
  });

  it("rejects invalid paths and query-bearing links", () => {
    expect(resolveSpaceInviteLink("/spaces/design-lab#token", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("/space/design-lab?token=secret", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("javascript:alert(1)", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("/space/design/lab#token", origin)).toBeUndefined();
  });

  it("shows an inline error for invalid input and navigates valid input with its hash", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { origin, assign } });

    render(<Hero />);
    const input = screen.getByLabelText("Have an invite link?");
    const form = input.closest("form");
    expect(form).not.toBeNull();

    fireEvent.change(input, { target: { value: "/not-a-space/token" } });
    fireEvent.submit(form!);
    expect(screen.getByRole("alert").textContent).toContain("valid Space invite link");
    expect(assign).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "/space/design-lab#spaceInviteToken=opaque-token" } });
    fireEvent.submit(form!);
    expect(assign).toHaveBeenCalledWith("https://chalk.test/space/design-lab#spaceInviteToken=opaque-token");

    vi.unstubAllGlobals();
  });
});
