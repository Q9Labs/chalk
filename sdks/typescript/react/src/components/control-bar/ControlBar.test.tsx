// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SpaceClientError } from "@q9labsai/chalk-client";
import { ControlBarSurface } from "./ControlBar";
import { commandFailureMessage } from "./command-failure";

afterEach(() => document.body.replaceChildren());

it("keeps Record in the dock and shows it pressed while recording", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let toggles = 0;
  const onToggleRecording = () => void toggles++;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<ControlBarSurface buttons={["record"]} detectDevices={false} onToggleRecording={onToggleRecording} />));
  const dock = document.querySelector("[data-part=dock]");
  expect(dock?.querySelector("[aria-label='Record']")?.getAttribute("aria-pressed")).not.toBe("true");

  act(() => root.render(<ControlBarSurface buttons={["record"]} detectDevices={false} onToggleRecording={onToggleRecording} isRecording />));
  const stop = dock?.querySelector<HTMLButtonElement>("[aria-label='Stop recording']");
  expect(stop?.getAttribute("aria-pressed")).toBe("true");
  act(() => stop?.click());
  expect(toggles).toBe(1);
  act(() => root.unmount());
});

it("never shows a raw server reason as the notice", () => {
  const rejected = (message: string) => new SpaceClientError({ code: "command.rejected", recoverable: false, message });
  expect(commandFailureMessage(rejected("external_operation_failed"))).toBe("That didn’t work. Try again in a moment.");
  expect(commandFailureMessage(rejected("Recording is not allowed for this Participant"))).toBe("Recording is not allowed for this Participant");
});

it("lets a host leave or end the call for everyone from the Leave call menu", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const calls: string[] = [];
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = () => root.render(<ControlBarSurface buttons={["leave"]} detectDevices={false} onLeft={() => void calls.push("leave")} onEndForEveryone={() => void calls.push("end")} />);
  const choose = async (name: string) => {
    await act(async () => document.querySelector<HTMLButtonElement>("[aria-label='Leave call']")?.click());
    const item = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((element) => element.textContent === name);
    expect(item, `${name} in the menu`).toBeDefined();
    await act(async () => item?.click());
  };
  act(render);
  await choose("Leave call");
  await choose("End call for everyone");
  expect(calls).toEqual(["leave", "end"]);
  act(() => root.unmount());
});
