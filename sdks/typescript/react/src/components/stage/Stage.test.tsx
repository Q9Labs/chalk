// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeMediaStreamTrack } from "../../test-support/fake-media-track";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { Stage } from "./Stage";
import { buildStageItems, screenShareItemId, type StageItem } from "./stage-items";

const box = vi.hoisted(() => ({ width: 960, height: 540 }));
vi.mock("../chalk-ui/useResizeObserver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chalk-ui/useResizeObserver")>()),
  useResizeObserver: () => ({ ref: { current: null }, dimensions: box }),
}));

afterEach(cleanup);
beforeEach(() => {
  box.width = 960;
  box.height = 540;
});

const person = (id: string, overrides: Partial<Participant> = {}): Participant => ({ id, displayName: id, ...overrides });
const people = (count: number): Participant[] => Array.from({ length: count }, (_, index) => person(`p${index + 1}`));
const tile = (name: string) => screen.getByRole("button", { name: `Video tile for ${name}` });
const size = (element: HTMLElement) => ({ width: element.style.width, height: element.style.height });

describe("Stage", () => {
  it("renders the empty state when there are no items", () => {
    render(<Stage items={[]} layout="grid" emptyState={<p>Quiet</p>} />);
    expect(screen.getByText("Quiet")).toBeInTheDocument();
  });

  it("gives every grid tile the same size and no pager when everything fits", () => {
    render(<Stage items={buildStageItems(people(4), false)} layout="grid" />);
    const tiles = screen.getAllByRole("button", { name: /^Video tile for/ });
    expect(tiles).toHaveLength(4);
    expect(new Set(tiles.map((element) => JSON.stringify(size(element))))).toEqual(new Set([JSON.stringify(size(tiles[0]!))]));
    expect(screen.queryByRole("navigation", { name: "Stage pages" })).not.toBeInTheDocument();
  });

  it("pages the grid, keeps off-page tiles mounted but hidden, and moves with arrows, dots and keys", () => {
    box.width = 400;
    box.height = 300;
    render(<Stage items={buildStageItems(people(9), false)} layout="grid" minTileWidth={160} />);

    const stage = screen.getByTestId("stage");
    const dots = screen.getAllByRole("button", { name: /^Go to page \d+$/ });
    expect(dots.length).toBeGreaterThan(1);
    expect(tile("p1")).not.toHaveAttribute("aria-hidden");
    expect(screen.getByLabelText("Video tile for p9")).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByLabelText("Video tile for p1")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "Go to page 2" })).toHaveAttribute("aria-current", "page");

    fireEvent.keyDown(stage, { key: "ArrowLeft" });
    expect(tile("p1")).not.toHaveAttribute("aria-hidden");

    fireEvent.click(dots[dots.length - 1]!);
    expect(screen.getByLabelText("Video tile for p1")).toHaveAttribute("aria-hidden", "true");
    expect(tile("p9")).not.toHaveAttribute("aria-hidden");
  });

  it("keeps the same tile elements when switching between grid and focus", () => {
    const items = buildStageItems([person("me", { isLocal: true }), person("ada", { isActiveSpeaker: true }), person("grace")], false);
    const view = render(<Stage items={items} layout="grid" />);
    const adaBefore = tile("ada");
    const gridSize = size(adaBefore);

    view.rerender(<Stage items={items} layout="focus" />);
    expect(tile("ada")).toBe(adaBefore);
    expect(size(tile("ada"))).not.toEqual(gridSize);
    expect(Number.parseFloat(tile("ada").style.width)).toBeGreaterThan(Number.parseFloat(tile("grace").style.width));
  });

  it("puts a screen share first in presentation and hands it to the primary renderer", () => {
    const track = createFakeMediaStreamTrack();
    const items = buildStageItems([person("me", { isLocal: true }), person("ada", { isScreenSharing: true, screenShareTrack: track })], false);
    const renderPrimaryContent = vi.fn((item: Extract<StageItem, { kind: "screen-share" | "whiteboard" }>) => <p>Primary {item.id}</p>);
    render(<Stage items={items} layout="presentation" renderPrimaryContent={renderPrimaryContent} />);

    expect(screen.getByText(`Primary ${screenShareItemId("ada")}`)).toBeInTheDocument();
    expect(renderPrimaryContent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ kind: "screen-share", track }));
    expect(screen.queryByRole("button", { name: "Screen share tile for ada" })).not.toBeInTheDocument();
  });

  it("shows unfocused content as a card and pins whatever is clicked", () => {
    const items = buildStageItems([person("me", { isLocal: true }), person("ada", { isActiveSpeaker: true, isScreenSharing: true, screenShareTrack: createFakeMediaStreamTrack() })], true);
    const onPinnedChange = vi.fn();
    render(<Stage items={items} layout="focus" onPinnedChange={onPinnedChange} renderPrimaryContent={(item) => <p>Primary {item.id}</p>} />);

    expect(screen.getByRole("button", { name: "Screen share tile for ada" })).toHaveTextContent("ada's screen");
    expect(screen.getByRole("button", { name: "Whiteboard tile" })).toHaveTextContent("Board");

    fireEvent.click(screen.getByRole("button", { name: "Whiteboard tile" }));
    expect(onPinnedChange).toHaveBeenCalledWith("whiteboard");
    expect(screen.getByText("Primary whiteboard")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Whiteboard tile" })).not.toBeInTheDocument();

    fireEvent.click(tile("me"));
    expect(onPinnedChange).toHaveBeenLastCalledWith("me");
    expect(screen.getByRole("button", { name: "Whiteboard tile" })).toBeInTheDocument();
  });

  it("respects a controlled pin and reports clicks", () => {
    const items = buildStageItems([person("me", { isLocal: true }), person("ada"), person("grace")], false);
    const onItemClick = vi.fn();
    render(<Stage items={items} layout="focus" pinnedId="grace" onItemClick={onItemClick} />);

    expect(Number.parseFloat(tile("grace").style.width)).toBeGreaterThan(Number.parseFloat(tile("ada").style.width));
    fireEvent.click(tile("ada"));
    expect(onItemClick).toHaveBeenCalledWith(expect.objectContaining({ id: "ada" }));
    expect(Number.parseFloat(tile("grace").style.width)).toBeGreaterThan(Number.parseFloat(tile("ada").style.width));
  });
});
