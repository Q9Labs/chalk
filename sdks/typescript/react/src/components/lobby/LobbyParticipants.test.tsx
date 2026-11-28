// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LobbyParticipants, type LobbyParticipant } from "./LobbyParticipants";

afterEach(() => document.body.replaceChildren());

function render(participants: readonly LobbyParticipant[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<LobbyParticipants participants={participants} />));
  return root;
}

const text = () => document.querySelector("[data-testid='lobby.names']")?.textContent;
const badges = () => document.querySelectorAll("[aria-label='AI participant']").length;

it("says who is in the call on one line and puts the AI sparkle after each AI participant's name", () => {
  const root = render([
    { displayName: "Nora", identityKind: "user" },
    { displayName: "Aria", identityKind: "agent" },
    { displayName: "Scribe", identityKind: "agent" },
  ]);
  expect(text()).toBe("Nora, Aria and Scribe are in this call");
  expect(badges()).toBe(2);
  expect(document.querySelector("[aria-label='Avatar for Aria']")).not.toBeNull();
  expect(document.body.textContent).not.toContain("transcribe");
  act(() => root.unmount());
});

it('uses "is" for one person and renders nothing for an empty roster', () => {
  const root = render([{ displayName: "Nora", identityKind: "user" }]);
  expect(text()).toBe("Nora is in this call");
  expect(badges()).toBe(0);
  act(() => root.unmount());
  const empty = render([]);
  expect(text()).toBeUndefined();
  act(() => empty.unmount());
});

it("names every AI participant, counts the other people, and lists everyone behind the others button", async () => {
  const root = render([
    { displayName: "Nora", identityKind: "user" },
    { displayName: "Tomás", identityKind: "user" },
    { displayName: "Priya", identityKind: "user" },
    { displayName: "Scribe", identityKind: "agent" },
    { displayName: "Wen", identityKind: "guest" },
  ]);
  expect(text()).toBe("Nora, Scribe and 3 others are in this call");
  await vi.waitFor(() => expect(document.querySelector("[data-testid='lobby.others']")).not.toBeNull());
  const others = document.querySelector<HTMLButtonElement>("[data-testid='lobby.others']");
  await act(async () => others?.click());
  expect(document.body.textContent).toContain("5 in this call");
  expect(document.body.textContent).toContain("Wen");
  act(() => root.unmount());
});
