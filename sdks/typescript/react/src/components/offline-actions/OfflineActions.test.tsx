/* @vitest-environment jsdom */

import type { OfflineAction, SpaceSnapshot } from "@q9labsai/chalk-client";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Chalk } from "../chalk/Chalk";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpaceView } from "../space-view/SpaceView";
import { useConnection } from "../../bindings/hooks";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support";
import { OfflineActions, RECONNECTING_GRACE_MS, offlineNoticeText } from "./OfflineActions";
import { OfflineActionsSetting } from "./OfflineActionsSetting";
import { RECONNECTING_NOTICE_MS } from "../reconnecting-overlay/ReconnectingOverlay";

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
  it("keeps the waiting count in the limbo after the grace period", async () => {
    vi.useFakeTimers();
    const { container } = await mount(withOffline("reconnecting", {}));
    await act(async () => vi.advanceTimersByTime(RECONNECTING_GRACE_MS));
    expect(container.querySelector("[role=status]")?.textContent).toBe("Reconnecting. 2 actions will send when you're back.");
    expect(container.querySelector("[role=dialog]")).toBeNull();
    expect(offlineNoticeText(1, false)).toBe("You're offline. 1 action will send when you're back.");
    expect(offlineNoticeText(0, false)).toBe("You're offline. Reconnecting…");
    vi.useRealTimers();
  });

  it("stays quiet through a short drop and says reconnecting, not offline, when the browser is online", async () => {
    vi.useFakeTimers();
    try {
      const { client, container } = await mount(withOffline("reconnecting", { pending: [] }));
      expect(container.querySelector("[role=status]")).toBeNull();
      await act(async () => vi.advanceTimersByTime(RECONNECTING_GRACE_MS));
      expect(container.querySelector("[role=status]")?.textContent).toBe("Reconnecting…");
      await act(async () => client.updateSnapshot((snapshot) => ({ ...snapshot, connection: { ...snapshot.connection, status: "live" } })));
      expect(container.querySelector("[role=status]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

it("uses one limbo through a continuous disconnection and lifts on recovery", async () => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const client = createPreviewClient(withOffline("reconnecting", { pending: [] }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    root.unmount();
    container.remove();
    vi.useRealTimers();
  };

  await act(async () => root.render(<Chalk client={client} entrance={false} />));
  expect(container.querySelector("[role=status]")).toBeNull();

  await act(async () => vi.advanceTimersByTime(RECONNECTING_NOTICE_MS));
  expect(container.querySelector("[role=status]")?.textContent).toBe("You're offline. Reconnecting…");
  await act(async () => vi.advanceTimersByTime(10_000));
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();

  await act(async () => client.updateSnapshot((snapshot) => ({ ...snapshot, connection: { ...snapshot.connection, status: "live" } })));
  expect(container.querySelector("[role=status]")).toBeNull();
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
});

it("restores call controls after recovery with SpaceView's public reconnecting prop", async () => {
  vi.useFakeTimers();
  try {
    function RecoveryView() {
      const connection = useConnection();
      return <SpaceView spaceName="Test call" reconnecting={{ isVisible: connection.status === "reconnecting", status: "reconnecting" }} />;
    }
    const { client, container } = await mount(withOffline("reconnecting", { pending: [] }), <RecoveryView />);
    await act(async () => vi.advanceTimersByTime(RECONNECTING_GRACE_MS + 50));
    expect(container.querySelectorAll('[role="status"]').length).toBe(1);
    const callButton = container.querySelector("button");
    expect(callButton).not.toBeNull();
    expect(callButton && isInert(callButton)).toBe(true);
    await act(async () => client.updateSnapshot((snapshot) => ({ ...snapshot, connection: { ...snapshot.connection, status: "live" } })));
    await act(async () => vi.advanceTimersByTime(500));
    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
    for (const button of container.querySelectorAll("button")) expect(isInert(button)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["left", "failed"] as const)("explains dropped offline actions on the %s screen", (status) => {
  const snapshot = withOffline(status, { pending: [], notice: "Your offline actions were not sent because the Episode ended or the connection closed." });
  const html = renderToStaticMarkup(<Chalk client={createPreviewClient(snapshot)} entrance={false} />);
  expect(html).toContain("Your offline actions were not sent");
});

function isInert(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    if (current.inert) return true;
    current = current.parentElement;
  }
  return false;
}
