// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ScreenSharePresentation } from "./composite/ScreenShareView";
import { SpaceHeader } from "./space-header/SpaceHeader";
import { StageContentTileSurface } from "./stage/StageContentTile";

afterEach(() => document.body.replaceChildren());

function render(element: React.ReactElement): void {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(element));
}

it("marks an agent's screen-share chip", () => {
  render(<ScreenSharePresentation sharedByName="Akash Rao" sharedByAgent media={<div />} mediaVisible />);
  expect(document.querySelectorAll("[aria-label='AI participant']")).toHaveLength(1);
});

it("marks an agent in the header avatar stack", () => {
  render(<SpaceHeader spaceName="Call" people={[{ participantId: "agent", displayName: "Akash Rao", identityKind: "agent" }]} onTogglePeople={() => undefined} />);
  expect(document.querySelectorAll("[aria-label='AI participant']")).toHaveLength(1);
});

it("carries the agent mark from a stage screen-share item", () => {
  render(<StageContentTileSurface item={{ kind: "screen-share", id: "screen-share:agent", participant: { id: "agent", displayName: "Akash Rao", identityKind: "agent", isScreenSharing: true } }} media={<div />} mediaVisible />);
  expect(document.querySelectorAll("[aria-label='AI participant']")).toHaveLength(1);
});
