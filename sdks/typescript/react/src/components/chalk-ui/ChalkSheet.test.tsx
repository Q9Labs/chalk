// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChalkSheet, type ChalkSheetProps } from "./ChalkSheet";

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  host.setAttribute("data-chalk", "");
  document.body.replaceChildren(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function open(props: Partial<ChalkSheetProps> = {}) {
  const onOpenChange = vi.fn();
  await act(async () =>
    root.render(
      <ChalkSheet variant="details" title="Audio" open onOpenChange={onOpenChange} {...props}>
        <button type="button">Row</button>
      </ChalkSheet>,
    ),
  );
  const sheet = host.querySelector<HTMLElement>("[data-variant]");
  if (!sheet) throw new Error("The sheet did not open.");
  sheet.getBoundingClientRect = () => new DOMRect(0, 400, 390, 400);
  return { sheet, onOpenChange };
}

/** A pointer event with a fixed position and clock, so the release speed is exact. */
const pointer = (target: Element, type: "pointerdown" | "pointermove" | "pointerup", y: number, time: number) =>
  act(async () => {
    const event = new MouseEvent(type, { bubbles: true, clientY: y });
    // React reads a zero timeStamp as missing, so the test clock starts at 1000 ms.
    Object.defineProperties(event, { pointerId: { value: 1 }, timeStamp: { value: 1000 + time } });
    target.dispatchEvent(event);
  });

const query = (selector: string): HTMLElement => {
  const element = host.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Nothing matches ${selector}.`);
  return element;
};
const grabber = () => query("[data-part=sheet-handle]");
const heading = () => query(".chalk-sheet-heading");

it("closes when dragged past 30% of its height", async () => {
  const { sheet, onOpenChange } = await open();
  await pointer(grabber(), "pointerdown", 0, 0);
  await pointer(grabber(), "pointermove", 60, 400);
  await pointer(grabber(), "pointermove", 130, 800);
  expect(sheet.style.transform).toBe("translateY(130px)");
  await pointer(grabber(), "pointerup", 130, 1200);
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(sheet.style.transform).toBe("translateY(100%)");
});

it("springs back in 240 ms when released at 30% or less, slowly", async () => {
  vi.useFakeTimers();
  const { sheet, onOpenChange } = await open();
  await pointer(heading(), "pointerdown", 0, 0);
  await pointer(heading(), "pointermove", 119, 600);
  await pointer(heading(), "pointerup", 119, 1200);
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(sheet.style.transform).toBe("");
  expect(sheet.style.transition).toContain("240ms");
  await act(async () => vi.advanceTimersByTime(240));
  expect(sheet.style.transition).toBe("");
});

it("closes on a flick over 0.5 px/ms from a short drag", async () => {
  const { onOpenChange } = await open();
  await pointer(grabber(), "pointerdown", 0, 0);
  await pointer(grabber(), "pointermove", 20, 20);
  await pointer(grabber(), "pointermove", 50, 50);
  await pointer(grabber(), "pointerup", 50, 60);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("does not count a quick short drag as a flick when the finger rests before the release", async () => {
  const { onOpenChange } = await open();
  await pointer(grabber(), "pointerdown", 0, 0);
  await pointer(grabber(), "pointermove", 50, 50);
  await pointer(grabber(), "pointerup", 50, 1050);
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("moves an upward drag a third as far and then springs back", async () => {
  const { sheet, onOpenChange } = await open();
  await pointer(grabber(), "pointerdown", 100, 0);
  await pointer(grabber(), "pointermove", 0, 500);
  expect(sheet.style.transform).toBe("translateY(-30px)");
  await pointer(grabber(), "pointerup", 0, 900);
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("starts no drag from a row or from the close button", async () => {
  const { sheet, onOpenChange } = await open();
  for (const target of [query(".chalk-sheet-body button"), query("[data-part=sheet-dismiss]")]) {
    await pointer(target, "pointerdown", 0, 0);
    await pointer(target, "pointermove", 300, 50);
    await pointer(target, "pointerup", 300, 60);
  }
  expect(sheet.style.transform).toBe("");
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("snaps without a spring when the person prefers reduced motion", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: media.includes("prefers-reduced-motion"), media, addEventListener() {}, removeEventListener() {} }));
  // The sheet gives its own transitions back from a timer, so hold the clock to see the release itself.
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const { sheet } = await open();
  await pointer(grabber(), "pointerdown", 0, 0);
  await pointer(grabber(), "pointermove", 40, 500);
  // The sheet gives its own transitions back on the next timer tick, so read it in the release's own tick:
  // an awaited release lets a loaded machine run that timer first.
  act(() => {
    const release = new MouseEvent("pointerup", { bubbles: true, clientY: 40 });
    Object.defineProperties(release, { pointerId: { value: 1 }, timeStamp: { value: 2000 } });
    grabber().dispatchEvent(release);
  });
  expect(sheet.style.transition).toBe("none");
  act(() => vi.runOnlyPendingTimers());
  expect(sheet.style.transition).toBe("");
});

it("has no scrim for the reactions sheet and a scrim for the others", async () => {
  await open({ variant: "reactions" });
  expect(host.querySelector("[data-part=sheet-scrim]")).toBeNull();
  await open({ variant: "default" });
  expect(host.querySelector("[data-part=sheet-scrim]")).not.toBeNull();
});

it("keeps the reactions sheet open when a tap lands on a call notice", async () => {
  const { onOpenChange } = await open({ variant: "reactions" });
  const toasts = document.createElement("div");
  toasts.className = "chalk-toasts";
  const dismiss = toasts.appendChild(document.createElement("button"));
  host.append(toasts);
  await act(async () => dismiss.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  await act(async () => dismiss.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(onOpenChange).not.toHaveBeenCalled();
  await act(async () => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  await act(async () => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("focuses the details sheet itself when it opens, not its close button", async () => {
  const { sheet } = await open();
  await vi.waitFor(() => expect(document.activeElement).toBe(sheet));
});
