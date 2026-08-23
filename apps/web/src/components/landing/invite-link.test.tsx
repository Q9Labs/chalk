/* @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Hero } from "./Hero";
import { resolveSpaceInviteLink } from "./invite-link";

describe("resolveSpaceInviteLink", () => {
  const origin = "https://chalk.test";

  it("accepts Space paths and preserves hash invite tokens", () => {
    expect(resolveSpaceInviteLink(" /space/design-lab#spaceInviteToken=opaque-token ", origin)).toBe("https://chalk.test/space/design-lab#spaceInviteToken=opaque-token");
    expect(resolveSpaceInviteLink("https://other.example/space/design-lab#token", origin)).toBe("https://other.example/space/design-lab#token");
  });

  it("rejects invalid paths and query-bearing links", () => {
    expect(resolveSpaceInviteLink("", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("//evil.example/space/design-lab", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("/spaces/design-lab#token", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("/space/design-lab?token=secret", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("javascript:alert(1)", origin)).toBeUndefined();
    expect(resolveSpaceInviteLink("/space/design/lab#token", origin)).toBeUndefined();
  });

  it("rejects invalid form input and navigates valid invites on the current origin", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { origin, assign } });

    render(<Hero />);
    const input = screen.getByLabelText("Already been sent a link?");
    const form = input.closest("form");
    expect(form).not.toBeNull();

    fireEvent.change(input, { target: { value: "/not-a-space/token" } });
    fireEvent.submit(form!);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "/space/design-lab#spaceInviteToken=opaque-token" } });
    fireEvent.submit(form!);
    expect(assign).toHaveBeenCalledWith(`${origin}/space/design-lab#spaceInviteToken=opaque-token`);

    vi.unstubAllGlobals();
  });
});
