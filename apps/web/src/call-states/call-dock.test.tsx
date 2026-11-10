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

const phoneWidth = () => vi.stubGlobal("matchMedia", (media: string) => ({ matches: media === "(max-width: 640px)", media, addEventListener() {}, removeEventListener() {} }));
const sheet = () => host.querySelector<HTMLElement>('[role="dialog"]');
const press = (element: Element, type: "pointerdown" | "pointerup") => act(async () => void element.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 })));
const settle = () => act(async () => vi.dynamicImportSettled());
const micButton = () => host.querySelector<HTMLButtonElement>('[data-part="mic-split"] .chalk-shell-main');

it("opens the microphone sheet after a 400 ms hold and leaves the mute state alone", async () => {
  phoneWidth();
  vi.useFakeTimers();
  try {
    await mount();
    const mic = micButton();
    if (!mic) throw new Error("No microphone button.");
    const muted = mic.getAttribute("aria-pressed");
    await press(mic, "pointerdown");
    await act(async () => vi.advanceTimersByTime(399));
    expect(sheet()).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    await settle();
    expect(sheet()?.textContent).toContain("Audio");
    expect(sheet()?.textContent).toContain("Noise suppression");
    await press(mic, "pointerup");
    await click(mic);
    expect(mic.getAttribute("aria-pressed")).toBe(muted);
  } finally {
    vi.useRealTimers();
  }
});

it("does not open a sheet for a tap, and has no camera caret on the phone dock", async () => {
  phoneWidth();
  vi.useFakeTimers();
  try {
    await mount();
    const mic = micButton();
    if (!mic) throw new Error("No microphone button.");
    const muted = mic.getAttribute("aria-pressed");
    await press(mic, "pointerdown");
    await act(async () => vi.advanceTimersByTime(150));
    await press(mic, "pointerup");
    await click(mic);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(sheet()).toBeNull();
    expect(mic.getAttribute("aria-pressed")).not.toBe(muted);
  } finally {
    vi.useRealTimers();
  }
});

it("lists the device rows in the More sheet, which opens the same pickers, and leaves out the call link", async () => {
  phoneWidth();
  await mount();
  await click(button("More options"));
  const rows = [...(sheet()?.querySelectorAll(".chalk-sheet-row") ?? [])].map((row) => row.textContent);
  expect(rows.some((row) => row?.startsWith("Microphone and speaker"))).toBe(true);
  expect(rows.some((row) => row?.startsWith("Camera"))).toBe(true);
  expect(rows.some((row) => /call link|Copy link/i.test(row ?? ""))).toBe(false);
  expect(rows.some((row) => row?.startsWith("Share screen"))).toBe(false);
  const audio = [...(sheet()?.querySelectorAll<HTMLButtonElement>("button.chalk-sheet-row") ?? [])].find((row) => row.textContent?.startsWith("Microphone and speaker"));
  await click(audio);
  await settle();
  expect(sheet()?.textContent).toContain("Noise suppression");
  expect(sheet()?.textContent).not.toContain("Flip camera");
});

it("shows reactions as a sheet with no scrim and closes it 120 ms after an emoji is sent", async () => {
  phoneWidth();
  vi.useFakeTimers();
  try {
    const client = await mount();
    const send = vi.spyOn(client.reactions, "send").mockReturnValue(new Promise(() => {}));
    await click(button("Reactions"));
    expect(sheet()).not.toBeNull();
    expect(host.querySelector("[data-part=sheet-scrim]")).toBeNull();
    expect(sheet()?.contains(tray())).toBe(true);
    const first = sheet()?.querySelector<HTMLButtonElement>(".chalk-sheet-emoji button");
    const emoji = first?.getAttribute("aria-label")?.replace("React with ", "");
    await click(first);
    expect(send).toHaveBeenCalledWith(emoji);
    await act(async () => vi.advanceTimersByTime(119));
    expect(sheet()).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(sheet()).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
