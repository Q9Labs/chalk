// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ControlBarSurface } from "./ControlBar";

afterEach(() => document.body.replaceChildren());

it("keeps Record in the dock and shows it pressed while recording", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onToggleRecording = vi.fn();
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<ControlBarSurface buttons={["record"]} detectDevices={false} onToggleRecording={onToggleRecording} />));
  const dock = document.querySelector("[data-part=dock]");
  expect(dock?.querySelector("[aria-label='Record']")?.getAttribute("aria-pressed")).not.toBe("true");

  act(() => root.render(<ControlBarSurface buttons={["record"]} detectDevices={false} onToggleRecording={onToggleRecording} isRecording />));
  const stop = dock?.querySelector<HTMLButtonElement>("[aria-label='Stop recording']");
  expect(stop?.getAttribute("aria-pressed")).toBe("true");
  act(() => stop?.click());
  expect(onToggleRecording).toHaveBeenCalledOnce();
  act(() => root.unmount());
});
