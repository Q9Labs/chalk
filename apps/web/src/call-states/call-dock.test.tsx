/* @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPreviewClient, createSnapshot, PreviewSpaceView } from "@q9labsai/chalk-react/preview";

const snapshot = () => {
  const base = createSnapshot(["raiseHand", "sendReaction"]);
  return { ...base, connection: { ...base.connection, status: "live" as const }, self: { ...base.self, participantId: "you", displayName: "Alex" } };
};

let host: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  host = document.createElement("div");
  document.body.replaceChildren(host);
});
afterEach(() => {
  host.remove();
  vi.unstubAllGlobals();
});

const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const tray = () => host.querySelector('[role="toolbar"][aria-label="Reactions"]');
const click = (element: HTMLElement | null | undefined) => act(async () => element?.click());

async function mount(client = createPreviewClient(snapshot())) {
  await act(async () => createRoot(host).render(<PreviewSpaceView client={client} spaceName="Q9 team" />));
  return client;
}

it("has no full screen button in the dock", async () => {
  await mount();
  expect(button("Leave call")).not.toBeNull();
  expect(button("Fullscreen")).toBeNull();
  expect(button("Exit fullscreen")).toBeNull();
});

it("closes the tray when the hand goes up and turns the reactions button into a hand", async () => {
  await mount();
  await click(button("Reactions"));
  expect(tray()).not.toBeNull();
  await click(host.querySelector<HTMLButtonElement>(".chalk-shell-raise"));
  expect(tray()).toBeNull();
  expect(button("Reactions, hand raised")?.hasAttribute("data-hand-raised")).toBe(true);
});

it("does not reopen the tray by itself after a reconnect", async () => {
  const client = await mount();
  await click(button("Reactions"));
  expect(tray()).not.toBeNull();
  await act(async () => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "reconnecting" } })));
  await act(async () => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "live" } })));
  expect(tray()).toBeNull();
});
