// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { usePortalTheme } from "./use-portal-theme";

function Popup() {
  return <span data-testid="popup">{usePortalTheme()}</span>;
}

describe("usePortalTheme", () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-chalk-theme");
    document.documentElement.classList.remove("dark");
  });

  it("follows the document when the host flips the theme under an open popup", async () => {
    document.documentElement.setAttribute("data-chalk-theme", "light");
    render(<Popup />);

    expect(screen.getByTestId("popup").textContent).toBe("light");

    await act(async () => {
      document.documentElement.setAttribute("data-chalk-theme", "dark");
    });

    expect(screen.getByTestId("popup").textContent).toBe("dark");
  });
});
