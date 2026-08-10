// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpisodeEmptyState, EpisodeErrorState, EpisodeListLoading, EpisodePagination, NoSpacesState } from "./EpisodeStates";

afterEach(() => cleanup());

describe("Episode loading and empty states", () => {
  it("announces loading history with three skeleton rows", () => {
    const { container } = render(<EpisodeListLoading />);
    const loadingPanel = container.querySelector("section");

    expect(loadingPanel?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll(".episode-loading-row")).toHaveLength(3);
    expect(screen.getByText("One moment")).toBeTruthy();
  });

  it("renders a retry action for a history error", () => {
    const onRetry = vi.fn();
    render(<EpisodeErrorState message="The service is unavailable" onRetry={onRetry} />);

    expect(screen.getByRole("alert").textContent).toContain("The service is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("directs tenants without Spaces to Space creation", () => {
    render(<NoSpacesState />);

    expect(screen.getByRole("heading", { name: "Create a Space before starting an Episode." })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create a Space" })).toHaveProperty("href", `${window.location.origin}/spaces`);
  });

  it("keeps the filtered empty state read-only", () => {
    render(<EpisodeEmptyState filtered onStart={vi.fn()} />);

    expect(screen.getByText("No matching history")).toBeTruthy();
    expect(screen.getByText("Try another filter.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start and join" })).toBeNull();
  });

  it("offers starting an Episode when there is no history", () => {
    const onStart = vi.fn();
    render(<EpisodeEmptyState filtered={false} onStart={onStart} />);

    fireEvent.click(screen.getByRole("button", { name: "Start and join" }));
    expect(onStart).toHaveBeenCalledOnce();
  });
});

describe("EpisodePagination", () => {
  it("omits pagination when there is no next page or cursor history", () => {
    const { container } = render(<EpisodePagination pagination={null} cursorHistory={[]} onPrevious={vi.fn()} onNext={vi.fn()} />);

    expect(container.firstChild).toBeNull();
  });

  it("enables only the available page controls", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(<EpisodePagination pagination={{ page_size: 25, next_cursor: "cursor-2", has_more: true }} cursorHistory={[]} onPrevious={onPrevious} onNext={onNext} />);

    expect(screen.getByText("Page 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNext).toHaveBeenCalledOnce();

    rerender(<EpisodePagination pagination={{ page_size: 25, next_cursor: null, has_more: false }} cursorHistory={["cursor-2"]} onPrevious={onPrevious} onNext={onNext} />);
    expect(screen.getByText("Page 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPrevious).toHaveBeenCalledOnce();
  });
});
