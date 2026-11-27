// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LobbyNotice, agentLobbyNotice, lobbySummary, type LobbyParticipant } from "./LobbyNotice";

afterEach(() => document.body.replaceChildren());

function render(participants: readonly LobbyParticipant[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<LobbyNotice participants={participants} />));
  return root;
}

it("caps the roster at two names and discloses every AI participant", () => {
  const root = render([
    { displayName: "Ada", identityKind: "user" },
    { displayName: "AI teammate", identityKind: "agent" },
    { displayName: "Sam", identityKind: "user" },
  ]);
  expect(document.body.textContent).toContain("Ada, AI teammate and 1 other are in this call");
  expect(document.body.textContent).toContain("AI teammate, an AI participant, is in this call.");
  expect(document.querySelectorAll("[data-testid='lobby.ai-notice']")).toHaveLength(1);
  act(() => root.unmount());
});

it("uses a supplied lobby notice and hides an empty roster", () => {
  expect(agentLobbyNotice({ displayName: "AI teammate", identityKind: "agent", notice: "A supplied notice is in this call." })).toBe("A supplied notice is in this call.");
  expect(lobbySummary([{ displayName: "Ada", identityKind: "user" }])).toBe("Ada is in this call");
  const root = render([]);
  expect(document.querySelector("[data-testid='lobby.notice']")).toBeNull();
  act(() => root.unmount());
});
