/* @vitest-environment jsdom */

import type { OfflineAction, SpaceSnapshot } from "@q9labsai/chalk-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support";
import { OfflineActions, offlineNoticeText } from "./OfflineActions";
import { OfflineActionsSetting } from "./OfflineActionsSetting";

const actions: readonly OfflineAction[] = [
  { id: "a", kind: "chat_message", text: "running late", queuedAt: Date.now() - 40_000 },
  { id: "b", kind: "hand_raise", text: null, queuedAt: Date.now() - 40_000 },
];
let cleanup: (() => void) | undefined;

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup?.();
  cleanup = undefined;
});

function withOffline(status: SpaceSnapshot["connection"]["status"], offline: Partial<SpaceSnapshot["offline"]>): SpaceSnapshot {
  const snapshot = createSnapshot();
  return { ...snapshot, connection: { ...snapshot.connection, status }, offline: { ...snapshot.offline, pending: actions, ...offline } };
}

async function mount(snapshot: SpaceSnapshot, node = <OfflineActions />) {
  const client = createPreviewClient(snapshot);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    root.unmount();
    container.remove();
  };
  await act(async () => root.render(<ChalkProvider client={client}>{node}</ChalkProvider>));
  return { client, container };
}

const button = (container: HTMLElement, name: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === name);

describe("OfflineActions", () => {
  it("shows a calm notice with the waiting count while reconnecting", async () => {
    const { container } = await mount(withOffline("reconnecting", {}));
    expect(container.querySelector("[role=status]")?.textContent).toBe("You're offline. 2 actions will send when you're back.");
    expect(container.querySelector("[role=dialog]")).toBeNull();
    expect(offlineNoticeText(1)).toBe("You're offline. 1 action will send when you're back.");
    expect(offlineNoticeText(0)).toBe("You're offline. Reconnecting…");
  });

  it("asks once the connection is back and sends on request, remembering the choice", async () => {
    const { client, container } = await mount(withOffline("live", { decisionNeeded: true }));
    expect(container.querySelector("[role=dialog]")?.textContent).toContain("Message: running late");
    expect(container.querySelector("[role=dialog]")?.textContent).toContain("Raise hand");
    await act(async () => container.querySelector<HTMLInputElement>("input[type=checkbox]")?.click());
    await act(async () => button(container, "Send actions")?.click());
    expect(window.localStorage.getItem("chalk:offline-actions-policy")).toBe("send");
    expect(client.getSnapshot().offline).toMatchObject({ pending: [], decisionNeeded: false, policy: "send" });
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });

  it("discards without remembering when the box stays unchecked", async () => {
    const { client, container } = await mount(withOffline("live", { decisionNeeded: true }));
    await act(async () => button(container, "Discard actions")?.click());
    expect(window.localStorage.getItem("chalk:offline-actions-policy")).toBeNull();
    expect(client.getSnapshot().offline.pending).toEqual([]);
  });

  it("lets Settings change the remembered choice", async () => {
    window.localStorage.setItem("chalk:offline-actions-policy", "send");
    const { container } = await mount(withOffline("live", {}), <OfflineActionsSetting />);
    const radios = [...container.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(radios.find((radio) => radio.checked)?.value).toBe("send");
    await act(async () => radios.find((radio) => radio.value === "ask")?.click());
    expect(window.localStorage.getItem("chalk:offline-actions-policy")).toBeNull();
  });
});
