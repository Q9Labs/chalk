// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "../../bindings/context";
import { createSnapshot, createTestClient } from "../../test-support/test-client";
import { SpaceView } from "./SpaceView";

const audioOutputSpy = vi.hoisted(() => vi.fn(() => null));
const controlBarSpy = vi.hoisted(() =>
  vi.fn((props: { readonly buttons?: readonly string[]; readonly onOpenDiagnostics?: () => void; readonly onOpenFeedback?: () => void; readonly onToggleParticipants?: () => void; readonly onLeft?: () => void }) => (
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
const participantGridSpy = vi.hoisted(() => vi.fn((props: { readonly layout: string; readonly participants?: unknown }) => <div data-testid="participant-grid">{props.layout}</div>));
const screenShareSpy = vi.hoisted(() => vi.fn(() => <div data-testid="screen-share-view" />));

vi.mock("../audio-output/AudioOutput", () => ({ AudioOutput: audioOutputSpy }));
vi.mock("../control-bar/ControlBar", () => ({ ControlBar: controlBarSpy }));
vi.mock("../participant-grid/ParticipantGrid", () => ({ ParticipantGrid: participantGridSpy }));
vi.mock("../composite/ScreenShareView", () => ({ ScreenShareView: screenShareSpy }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  audioOutputSpy.mockClear();
  controlBarSpy.mockClear();
  participantGridSpy.mockClear();
  screenShareSpy.mockClear();
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
    expect(participantGridSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ layout: "grid" }));
    expect(participantGridSpy.mock.calls[0]?.[0]).not.toHaveProperty("participants");
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

  it("adds a named Feedback control instead of reusing More", () => {
    const onOpenFeedback = vi.fn();
    renderView(createTestClient(), { onOpenFeedback });

    expect(controlBarSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ buttons: expect.arrayContaining(["feedback"]), onOpenFeedback }));
    expect(controlBarSpy.mock.calls[0]?.[0].buttons).not.toContain("more");
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
    const stageLayout = screen.getByRole("region", { name: "Space stage" }).parentElement;

    expect(chrome).toHaveClass("h-full", "w-full");
    expect(chrome?.className).not.toContain("max-w-");
    expect(stageLayout).toHaveClass("w-full");
    expect(stageLayout?.className).not.toContain("max-w-");
  });

  it("uses the pre-redesign stage and panel layout by default", () => {
    const client = createTestClient(createSnapshot(["sendChat"]));
    const { container } = renderView(client, { features: { chat: true }, initialPanel: "chat" });
    const stage = screen.getByRole("region", { name: "Space stage" });
    const panel = screen.getByRole("complementary", { name: "Chat panel" }).parentElement;

    expect(screen.getByRole("main")).toHaveAttribute("data-chalk-skin", "classic");
    expect(stage).toHaveClass("chalk-textured-surface", "rounded-[10px]", "bg-[var(--chalk-app-stage)]");
    expect(panel).toHaveClass("chalk-textured-surface", "rounded-[10px]", "border", "shadow-[var(--chalk-app-shadow-sm)]");
    expect(container.querySelector("svg[data-chalk-chrome='true']")).not.toBeInTheDocument();
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

  it("uses the context screen-share view when a live screen track is present", () => {
    const track = { readyState: "live" } as MediaStreamTrack;
    const client = createTestClient(createSnapshot(["publishScreen"]));
    client.setSnapshot({
      ...client.getSnapshot(),
      connection: { ...client.getSnapshot().connection, status: "live" },
      self: { ...client.getSnapshot().self, participantId: "local", displayName: "You" },
      media: { ...client.getSnapshot().media, local: { ...client.getSnapshot().media.local, screen: { source: "screen", state: "enabled", track } }, screenShare: { source: "screen", state: "enabled", track } },
    });
    renderView(client, { layout: "presentation" });
    expect(screenShareSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ className: "h-full" }));
  });
});
