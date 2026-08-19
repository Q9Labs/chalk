/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchDialog } from "./SearchDialog";

afterEach(cleanup);

describe("SearchDialog", () => {
  it("focuses the search field, filters pages, and moves the active result", async () => {
    const onClose = vi.fn();
    render(<SearchDialog open onClose={onClose} />);

    const input = screen.getByRole("combobox", { name: /Search documentation/ });
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.change(input, { target: { value: "webhook" } });
    const results = screen.getAllByRole("option");
    expect(results.length).toBeGreaterThan(0);
    expect(screen.getByRole("option", { name: /Webhooks/ })).toBeTruthy();
    expect(input.getAttribute("aria-activedescendant")).toBe("docs-search-result-0");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("docs-search-result-1");
    expect(results[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("reports empty searches, closes from Escape, and restores the trigger focus", async () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "Open search";
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = render(<SearchDialog open onClose={onClose} />);
    const input = screen.getByRole("combobox", { name: /Search documentation/ });
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.change(input, { target: { value: "zzzz-no-doc-page" } });
    expect(screen.getByText("No pages match “zzzz-no-doc-page”. Try a broader term.")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    rerender(<SearchDialog open={false} onClose={onClose} />);
    expect(document.activeElement).toBe(trigger);
  });
});
