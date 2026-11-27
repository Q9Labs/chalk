// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LobbyNotice, lobbyNotice, lobbySummary, type LobbyParticipant } from "./LobbyNotice";

afterEach(() => document.body.replaceChildren());

function render(participants: readonly LobbyParticipant[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<LobbyNotice participants={participants} />));
  return root;
}

it("says who is in the call on one line, marks AI participants inline and shows only the supplied notice", () => {
  const root = render([
    { displayName: "Ada", identityKind: "user" },
    { displayName: "Aria", identityKind: "agent" },
    { displayName: "Scribe", identityKind: "agent", notice: "Scribe may transcribe this call." },
  ]);
  expect(document.body.textContent).toContain("Ada, Aria (AI) and Scribe (AI) are in this call");
  expect(document.querySelector("[data-testid='lobby.ai-notice']")?.textContent).toBe("Scribe may transcribe this call.");
  act(() => root.unmount());
});

it("adds no notice line when no AI participant supplied one, and hides an empty roster", () => {
  const root = render([{ displayName: "Aria", identityKind: "agent" }]);
  expect(document.body.textContent).toContain("Aria (AI) is in this call");
  expect(document.querySelector("[data-testid='lobby.ai-notice']")).toBeNull();
  act(() => root.unmount());
  const empty = render([]);
  expect(document.querySelector("[data-testid='lobby.notice']")).toBeNull();
  act(() => empty.unmount());
});

it("counts the AI participants among the others once the roster passes three", () => {
  expect(
    lobbySummary([
      { displayName: "Ada", identityKind: "user" },
      { displayName: "Sam", identityKind: "user" },
      { displayName: "Aria", identityKind: "agent" },
      { displayName: "Sol", identityKind: "user" },
    ]),
  ).toBe("Ada, Sam and 2 others (1 AI) are in this call");
  expect(lobbyNotice([{ displayName: "Aria", identityKind: "agent", notice: " Aria may transcribe this call. " }])).toBe("Aria may transcribe this call.");
});
