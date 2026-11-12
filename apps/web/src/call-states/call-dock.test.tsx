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

// Alone at call start the call menu opens with the invite; the dock tests start with it closed so only their own sheet shows.
async function mount(client = createPreviewClient(snapshot()), callLink: "closed" | "auto" = "closed") {
  await act(async () => createRoot(host).render(<PreviewSpaceView client={client} spaceName="Q9 team" callLinkOpen={callLink === "closed" ? false : undefined} />));
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

it("keeps the tray through a reconnect, with emoji paused and the hand still working", async () => {
  const client = await mount();
  await click(button("Reactions"));
  await act(async () => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "reconnecting" } })));
  expect(tray()).not.toBeNull();
  expect(tray()?.querySelector<HTMLButtonElement>(".chalk-shell-emoji")?.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>(".chalk-shell-raise")?.disabled).toBe(false);
  await act(async () => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "live" } })));
  expect(tray()?.querySelector<HTMLButtonElement>(".chalk-shell-emoji")?.disabled).toBe(false);
});

it("opens the call menu with the QR code for a person alone at call start", async () => {
  await mount(undefined, "auto");
  await settle();
  const menu = await vi.waitFor(() => {
    // The desktop call menu is a popover portalled to the body.
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog?.textContent?.includes("QR code")) throw new Error("No call menu yet.");
    return dialog;
  });
  expect(menu.querySelector('[aria-controls="chalk-details-qr"]')?.getAttribute("aria-expanded")).toBe("true");
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
    // The fixture passes no noise-suppression handler, so the switch is not offered.
    expect(sheet()?.textContent).not.toContain("Noise suppression");
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
  expect(sheet()?.textContent).toContain("Audio");
  expect(sheet()?.textContent).not.toContain("Flip camera");
});

it("shows reactions as a sheet with no scrim and closes it 120 ms after an emoji is sent", async () => {
  phoneWidth();
  vi.useFakeTimers();
  try {
    const client = await mount();
    const send = vi.spyOn(client.reactions, "send").mockReturnValue(new Promise(() => {}));
    await click(button("Reactions"));
    await settle();
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

it("does not let a sent emoji's close timer shut a tray that was reopened in the meantime", async () => {
  phoneWidth();
  vi.useFakeTimers();
  try {
    const client = await mount();
    vi.spyOn(client.reactions, "send").mockReturnValue(new Promise(() => {}));
    await click(button("Reactions"));
    await settle();
    await click(sheet()?.querySelector<HTMLButtonElement>(".chalk-sheet-emoji button"));
    await act(async () => vi.advanceTimersByTime(50));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await click(button("Reactions"));
    await settle();
    expect(sheet()).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(300));
    expect(sheet()).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
