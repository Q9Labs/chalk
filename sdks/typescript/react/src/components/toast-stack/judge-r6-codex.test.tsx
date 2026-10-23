// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
import { ToastStack } from "./ToastStack";
import { ChalkToast } from "../chalk-ui/ChalkToast";
import { Stage, type StageItem } from "../stage/Stage";
import { fitSpotlight, DEFAULT_SPOTLIGHT_OPTIONS } from "../stage/stage-layout";

it("does not remount a folded rich toast for equivalent new JSX icons", async () => {
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.part === "call-frame" ? 844 : 60;
  });
  const child = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80);
  const frame = document.createElement("main");
  frame.dataset.part = "call-frame";
  document.body.append(frame);
  const root = createRoot(frame),
    mounted = vi.fn(),
    unmounted = vi.fn();
  function Message() {
    useEffect(() => {
      mounted();
      return () => {
        unmounted();
      };
    }, []);
    return <input />;
  }
  function Icon() {
    return <svg aria-hidden="true" />;
  }
  const fold = () => {};
  const render = () => act(async () => root.render(<ToastStack toasts={[{ id: "same", message: <Message />, announcementText: "Camera blocked", icon: <Icon /> }]} onDismiss={() => {}} onFold={fold} />));
  try {
    await render();
    const initialMounts = mounted.mock.calls.length;
    for (let i = 0; i < 3; i++) await render();
    console.log("ICON_REPRO", { initialMounts, afterEquivalentUpdates: mounted.mock.calls.length, unmounts: unmounted.mock.calls.length });
    expect(frame.querySelectorAll("[data-part=toast]")).toHaveLength(0);
    expect(mounted).toHaveBeenCalledTimes(initialMounts);
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    width.mockRestore();
    height.mockRestore();
    child.mockRestore();
  }
});

it("turns off live-region attributes when announce changes to false", async () => {
  const frame = document.createElement("main");
  document.body.append(frame);
  const root = createRoot(frame);
  const render = (announce: boolean) => act(async () => root.render(<ChalkToast message="Camera blocked" duration={Infinity} announce={announce} onDismiss={() => {}} />));
  try {
    await render(true);
    expect(frame.querySelector("[data-part=toast]")?.getAttribute("aria-live")).toBe("polite");
    await render(false);
    const toast = frame.querySelector("[data-part=toast]");
    console.log("LIVE_REPRO", { role: toast?.getAttribute("role"), live: toast?.getAttribute("aria-live") });
    expect(toast?.getAttribute("aria-live")).toBeNull();
    expect(toast?.getAttribute("role")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    frame.remove();
  }
});

it("includes shares in the configured phone-board floating limit", () => {
  const geometry = fitSpotlight({ width: 390, height: 844 }, "board", ["share-a", "share-b", "nora", "akash", "self"], { ...DEFAULT_SPOTLIGHT_OPTIONS, content: true, floatingPhonePeople: true, wideIds: ["share-a", "share-b"], maxPerPage: 2, speakerId: "nora", localId: "self" });
  const floats = geometry.frames.filter((frame) => frame.role === "float");
  console.log(
    "FLOAT_REPRO",
    floats.map((frame) => frame.id),
  );
  expect(floats.length).toBeLessThanOrEqual(2);
});

it("does not mount a second caller content tree when folded content opens", async () => {
  const person: StageItem = { kind: "participant", id: "person", participant: { id: "person", displayName: "Nora" } };
  const items: StageItem[] = [person, { kind: "screen-share", id: "share", participant: person.participant }, { kind: "whiteboard", id: "whiteboard" }];
  const active = new Map<string, number>();
  function Content({ id }: { id: string }) {
    useEffect(() => {
      active.set(id, (active.get(id) ?? 0) + 1);
      return () => {
        active.set(id, (active.get(id) ?? 0) - 1);
      };
    }, [id]);
    return <div data-caller-content={id}>{id} is readable</div>;
  }
  const frame = document.createElement("main");
  document.body.append(frame);
  const root = createRoot(frame);
  try {
    await act(async () => root.render(<Stage items={items} layout="grid" maxPerPage={1} generatedAvatars={false} animate={false} renderPrimaryContent={(item) => <Content id={item.id} />} />));
    const before = Object.fromEntries(active);
    await act(async () => frame.querySelector<HTMLButtonElement>("[data-stage-item='stage:more']")!.click());
    console.log("TREE_REPRO", { before, after: Object.fromEntries(active) });
    expect(frame.querySelector("[role=dialog]")?.textContent).toContain("share is readable");
    expect(active.get("share")).toBe(1);
    expect(active.get("whiteboard")).toBe(1);
  } finally {
    await act(async () => root.unmount());
    frame.remove();
  }
});
