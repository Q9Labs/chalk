// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SkinProvider } from "../skin-context";
import { TileShell } from "./TileShell";

afterEach(cleanup);

describe("TileShell", () => {
  it("exposes an interactive tile with its media, status, and corner slots", () => {
    const onClick = vi.fn();
    const onDoubleClick = vi.fn();

    render(
      <TileShell label="Video tile for Nora" accentColor="#7c3aed" pinned onClick={onClick} onDoubleClick={onDoubleClick} dataTour="participant-tile" style={{ minHeight: "120px" }} chip={<span>Nora · Speaking</span>} corner={<span aria-label="Connection warning">!</span>}>
        <div>Video frame</div>
      </TileShell>,
    );

    const tile = screen.getByRole("button", { name: "Video tile for Nora" });
    expect(tile).toHaveAttribute("data-tour", "participant-tile");
    expect(tile).toHaveStyle({ minHeight: "120px", "--chalk-participant-color": "#7c3aed", "--tw-ring-color": "#7c3aed80" });
    expect(tile).toHaveClass("ring-2", "cursor-pointer");
    expect(screen.getByText("Video frame")).toBeInTheDocument();
    expect(screen.getByText("Nora · Speaking")).toBeInTheDocument();
    expect(screen.getByLabelText("Connection warning")).toBeInTheDocument();

    fireEvent.keyDown(tile, { key: "Enter" });
    fireEvent.keyDown(tile, { key: " " });
    fireEvent.keyDown(tile, { key: "Escape" });
    fireEvent.click(tile);
    fireEvent.doubleClick(tile);

    expect(onClick).toHaveBeenCalledTimes(3);
    expect(onDoubleClick).toHaveBeenCalledOnce();
  });

  it("uses the classic chip treatment and removes hidden tiles from tab order", () => {
    render(
      <SkinProvider skin="classic">
        <TileShell label="Video tile for Nora" accentColor="#ef4444" chip={<span>Nora</span>} />
        <TileShell label="Video tile for Eli" accentColor="#22c55e" onClick={() => undefined} hidden />
      </SkinProvider>,
    );

    const classicTile = screen.getByRole("region", { name: "Video tile for Nora" });
    expect(classicTile.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();
    expect(screen.getByText("Nora")).toBeInTheDocument();

    const hiddenTile = document.querySelector('[aria-label="Video tile for Eli"]');
    expect(hiddenTile).toBeInTheDocument();
    expect(hiddenTile).toHaveAttribute("aria-hidden", "true");
    expect(hiddenTile).not.toHaveAttribute("tabindex");
  });
});
