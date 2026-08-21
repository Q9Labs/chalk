// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SkinProvider } from "../skin-context";
import { StatusSurface } from "./StatusSurface";

afterEach(cleanup);

describe("StatusSurface", () => {
  it("keeps the production status copy and retry control", () => {
    const onRetry = vi.fn();

    render(
      <SkinProvider skin="classic">
        <StatusSurface message="You have left this Space." onRetry={onRetry} />
      </SkinProvider>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("You have left this Space.");
    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-skin", "classic");
    expect(screen.getByRole("button", { name: "Try again" })).toHaveAttribute("data-chalk-tone", "accent");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("decorates a completed local leave with only the Episode data it receives", () => {
    const onRetry = vi.fn();

    render(
      <SkinProvider skin="classic">
        <StatusSurface message="You have left this Space." phase="left" spaceName="Design review" episode={{ id: "episode-123", startedAt: "2026-08-21T09:00:00.000Z", deadline: null }} endedAt="2026-08-21T09:42:00.000Z" participantCount={3} onRetry={onRetry} />
      </SkinProvider>,
    );

    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-status", "left");
    expect(screen.getByRole("heading", { name: "You left this Space" })).toBeInTheDocument();
    expect(screen.getByText("Design review")).toBeInTheDocument();
    expect(screen.getByText("episode-123")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("42m 0s")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows a natural Episode end without fabricating statistics", () => {
    render(
      <SkinProvider skin="chalk">
        <StatusSurface message="This Episode has ended." phase="episode-ended" spaceName="Town hall" episode={{ id: "episode-456", startedAt: null, deadline: null }} />
      </SkinProvider>,
    );

    expect(screen.getByRole("heading", { name: "Episode ended" })).toBeInTheDocument();
    expect(screen.getByText("Town hall")).toBeInTheDocument();
    expect(screen.getByText("episode-456")).toBeInTheDocument();
    expect(screen.queryByText(/Participants/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Duration/)).not.toBeInTheDocument();
  });

  it("keeps retry failures visible while the real retry callback is pending", () => {
    const onRetry = vi.fn();

    render(
      <SkinProvider skin="classic">
        <StatusSurface message="You have left this Space." phase="left" retryError="Re-entry failed." retryPending onRetry={onRetry} />
      </SkinProvider>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Re-entry failed.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  });

  it("does not render retry when the lifecycle is not retryable", () => {
    render(
      <SkinProvider skin="chalk">
        <StatusSurface message="Leaving Design review…" />
      </SkinProvider>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Leaving Design review…");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-skin", "chalk");
  });
});
