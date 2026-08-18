// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "../../bindings/context";
import { createFakeMediaStreamTrack } from "../../test-support/fake-media-track";
import { createSnapshot, createTestClient } from "../../test-support/test-client";
import { SpaceView } from "./SpaceView";

const audioOutputSpy = vi.hoisted(() => vi.fn(() => null));
const controlBarSpy = vi.hoisted(() =>
  vi.fn((props: { readonly buttons?: readonly string[]; readonly onOpenDiagnostics?: () => void; readonly onToggleParticipants?: () => void; readonly onLeft?: () => void }) => (
    <>
      <button type="button" onClick={props.onToggleParticipants}>
        People
      </button>
      <button type="button" onClick={props.onLeft}>
        Leave space
      </button>
    </>
  )),
);
const spaceStageSpy = vi.hoisted(() => vi.fn((props: { readonly layout: string; readonly tiles: readonly { readonly id: string; readonly screenShareTrack?: MediaStreamTrack | null }[] }) => <div data-testid="space-stage">{props.layout}</div>));

vi.mock("../audio-output/AudioOutput", () => ({ AudioOutput: audioOutputSpy }));
vi.mock("../control-bar/ControlBar", () => ({ ControlBar: controlBarSpy }));
vi.mock("./SpaceStage", () => ({ SpaceStage: spaceStageSpy }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  audioOutputSpy.mockClear();
  controlBarSpy.mockClear();
  spaceStageSpy.mockClear();
});

function renderView(client = createTestClient(), props: Partial<React.ComponentProps<typeof SpaceView>> = {}) {
  client.setSnapshot({ ...client.getSnapshot(), connection: { ...client.getSnapshot().connection, status: "live" } });
  return {
    client,
    ...render(
      <ChalkProvider client={client}>
        <SpaceView spaceName="Design review" {...props} />
      </ChalkProvider>,
    ),
  };
}

describe("SpaceView", () => {
  it("composes context-connected components without passing state envelopes", () => {
    renderView(createTestClient(), { layout: "grid", features: { chat: true, participants: true } });
    expect(screen.getByRole("main")).toHaveAttribute("data-chalk");
    expect(spaceStageSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ layout: "grid" }));
    expect(controlBarSpy.mock.calls[0]?.[0]).not.toHaveProperty("controls");
  });

  it("omits diagnostics unless an open handler is provided", () => {
    renderView();

    expect(controlBarSpy.mock.calls[0]?.[0].buttons).not.toContain("diagnostics");
  });

  it("adds diagnostics and forwards its open handler together", () => {
    const onOpenDiagnostics = vi.fn();
    renderView(createTestClient(), { onOpenDiagnostics });

    expect(controlBarSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ buttons: expect.arrayContaining(["diagnostics"]), onOpenDiagnostics }));
  });

  it("keeps the typed skin, palette, and texture attributes on the layout", () => {
    renderView(createTestClient(), { skin: "chalk", palette: "warm-charcoal", texture: "paper" });
    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-theme", "dark");
    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-skin", "chalk");
    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-palette", "warm-charcoal");
    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-texture", "paper");
  });

  it("uses the full host viewport instead of capping the Space chrome and stage", () => {
    const { container } = renderView();
    const chrome = container.querySelector("main > section");
    const stageColumn = screen.getByRole("region", { name: "Space stage" }).parentElement;

    expect(chrome).toHaveClass("h-full", "w-full");
    expect(chrome?.className).not.toContain("max-w-");
    expect(stageColumn).toHaveClass("flex-1", "min-w-0");
    expect(stageColumn?.className).not.toContain("max-w-");
  });

  it("uses the pre-redesign stage and panel layout by default", () => {
    const client = createTestClient(createSnapshot(["sendChat"]));
    const { container } = renderView(client, { features: { chat: true }, initialPanel: "chat" });
    const stage = screen.getByRole("region", { name: "Space stage" });
    const drawer = container.querySelector("[data-chalk-drawer]");

    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-skin", "classic");
    expect(stage).toHaveClass("chalk-textured-surface", "rounded-[10px]", "bg-[var(--chalk-app-stage)]");
    expect(drawer).toHaveClass("chalk-drawer");
    expect(drawer?.firstElementChild).toHaveClass("chalk-drawer-content", "chalk-textured-surface", "shadow-[var(--chalk-app-shadow-xs)]");
    expect(drawer).toContainElement(screen.getByRole("complementary", { name: "Chat panel" }));
    expect(container.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();
  });

  it("docks open panels in the right-hand drawer and closes it on Escape", () => {
    const client = createTestClient(createSnapshot(["sendChat"]));
    const { container } = renderView(client, { features: { chat: true, participants: true }, initialPanel: "chat" });
    const drawer = container.querySelector("[data-chalk-drawer]");

    expect(drawer).toHaveAttribute("data-state", "open");
    expect(drawer).toContainElement(screen.getByRole("complementary", { name: "Chat panel" }));
    expect(drawer).toContainElement(document.activeElement);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    expect(container.querySelector("[data-chalk-drawer]")).toHaveAttribute("data-state", "closing");
    expect(screen.getByRole("complementary", { name: "Chat panel" })).toBeInTheDocument();
  });

  it("removes the drawer once its exit animation has finished", () => {
    vi.useFakeTimers();
    const client = createTestClient(createSnapshot(["sendChat"]));
    const { container } = renderView(client, { features: { chat: true }, initialPanel: "chat" });

    fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
    expect(container.querySelector("[data-chalk-drawer]")).toHaveAttribute("data-state", "closing");

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(container.querySelector("[data-chalk-drawer]")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Chat panel" })).not.toBeInTheDocument();
  });

  it("returns focus to the opener when the drawer closes", () => {
    const client = createTestClient(createSnapshot(["sendChat"]));
    const { container } = renderView(client, { features: { participants: true } });
    const opener = screen.getAllByRole("button", { name: "People" })[0]!;

    opener.focus();
    fireEvent.click(opener);
    expect(container.querySelector("[data-chalk-drawer]")).toContainElement(document.activeElement);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(document.activeElement).toBe(opener);
  });

  it("uses chalk chrome for the stage and an open side panel", () => {
    const client = createTestClient(createSnapshot(["sendChat"]));
    const { container } = renderView(client, { skin: "chalk", features: { chat: true }, initialPanel: "chat" });

    expect(screen.getByRole("region", { name: "Space stage" }).querySelector("svg[data-chalk-chrome='true']")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Chat panel" }).querySelector("svg[data-chalk-chrome='true']")).toBeInTheDocument();
    expect(container.querySelector("main > section svg[data-chalk-chrome='true']")).toBeInTheDocument();
  });

  it("opens the provider-backed participant panel from the control bar", () => {
    const client = createTestClient(createSnapshot(["sendChat"]));
    renderView(client, { features: { participants: true } });
    fireEvent.click(screen.getAllByRole("button", { name: "People" })[0]!);
    expect(screen.getByRole("complementary", { name: "Participants list" })).toBeInTheDocument();
  });

  it("surfaces queued admission requests for a permitted approver", () => {
    const client = createTestClient(createSnapshot(["manageAdmission"]));
    client.setSnapshot({
      ...client.getSnapshot(),
      connection: { ...client.getSnapshot().connection, status: "live" },
      participants: { ...client.getSnapshot().participants, admissionQueue: [{ requestId: "request-1", displayName: "Guest" }] },
    });

    renderView(client, { features: { admission: true } });

    expect(screen.getByRole("complementary", { name: "Admission requests" })).toBeInTheDocument();
    expect(screen.getByText("Guest")).toBeInTheDocument();
  });

  it("hands live screen-share tracks to the stage as tiles", () => {
    const track = createFakeMediaStreamTrack();
    const client = createTestClient(createSnapshot(["publishScreen"]));
    client.setSnapshot({
      ...client.getSnapshot(),
      connection: { ...client.getSnapshot().connection, status: "live" },
      self: { ...client.getSnapshot().self, participantId: "local", displayName: "You" },
      media: { ...client.getSnapshot().media, local: { ...client.getSnapshot().media.local, screen: { source: "screen", state: "enabled", track } }, screenShare: { source: "screen", state: "enabled", track } },
    });
    renderView(client, { layout: "presentation" });
    expect(spaceStageSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ layout: "presentation", className: "h-full" }));
    expect(spaceStageSpy.mock.calls[0]?.[0].tiles).toEqual([expect.objectContaining({ id: "local", screenShareTrack: track })]);
  });
});
