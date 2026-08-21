// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SkinProvider } from "../skin-context";
import { LeaveDialog } from "./LeaveDialog";

afterEach(cleanup);

function renderDialog(skin: "chalk" | "classic", overrides: Partial<React.ComponentProps<typeof LeaveDialog>> = {}) {
  return render(
    <SkinProvider skin={skin}>
      <LeaveDialog isOpen onClose={vi.fn()} onConfirm={vi.fn()} onEndEpisode={vi.fn()} {...overrides} />
    </SkinProvider>,
  );
}

describe("LeaveDialog", () => {
  it.each(["chalk", "classic"] as const)("keeps local leave separate from End Episode on the %s skin", (skin) => {
    const onConfirm = vi.fn();
    const onEndEpisode = vi.fn();
    renderDialog(skin, { onConfirm, onEndEpisode });

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Leave this Space?");
    expect(screen.getByRole("button", { name: "Leave Space" })).toHaveAttribute("data-chalk-action", "leave-space");
    expect(screen.getByRole("button", { name: "End Episode for everyone" })).toHaveAttribute("data-chalk-action", "open-end-episode-confirmation");

    fireEvent.click(screen.getByRole("button", { name: "Leave Space" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onEndEpisode).not.toHaveBeenCalled();
  });

  it("requires a second, explicit confirmation before ending the Episode", () => {
    const onConfirm = vi.fn();
    const onEndEpisode = vi.fn();
    renderDialog("classic", { onConfirm, onEndEpisode });

    fireEvent.click(screen.getByRole("button", { name: "End Episode for everyone" }));

    expect(screen.getByRole("heading", { name: "End Episode for everyone?" })).toBeInTheDocument();
    expect(screen.getByText("This affects everyone in the Episode.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End Episode for everyone" })).toHaveAttribute("data-chalk-action", "end-episode");
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "End Episode for everyone" }));
    expect(onEndEpisode).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("hides the destructive action when the capability is not present", () => {
    renderDialog("chalk", { canEndEpisode: false });

    expect(screen.queryByRole("button", { name: "End Episode for everyone" })).not.toBeInTheDocument();
  });

  it("keeps failures actionable and exposes pending state", () => {
    const onConfirm = vi.fn();
    renderDialog("classic", { onConfirm, leavePending: true, leaveError: "Leave failed." });

    expect(screen.getByRole("alert")).toHaveTextContent("Leave failed.");
    expect(screen.getByRole("button", { name: "Leaving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "End Episode for everyone" })).toBeDisabled();
  });

  it("closes with Escape without invoking either destructive action", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const onEndEpisode = vi.fn();
    renderDialog("classic", { onClose, onConfirm, onEndEpisode });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onEndEpisode).not.toHaveBeenCalled();
  });
});
