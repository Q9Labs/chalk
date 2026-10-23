// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Stage, type StageItem } from "./Stage";

it("keeps capped shared content readable in overflow, even with a single stage slot", async () => {
  const person: StageItem = { kind: "participant", id: "person", participant: { id: "person", displayName: "Nora" } };
  const items: StageItem[] = [person, { kind: "screen-share", id: "share", participant: person.participant }, { kind: "whiteboard", id: "whiteboard" }];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Stage items={items} layout="grid" maxPerPage={1} generatedAvatars={false} animate={false} renderPrimaryContent={(item) => <div>{item.id} is readable</div>} />));
    const more = container.querySelector<HTMLButtonElement>("[data-stage-item='stage:more']");
    if (!more) throw new Error("Missing content overflow button");
    await act(async () => more.click());
    const dialog = container.querySelector("[role='dialog']");
    expect(dialog?.textContent).toContain("share is readable");
    expect(dialog?.textContent).toContain("whiteboard is readable");
    expect(dialog?.textContent).toContain("Nora");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("owns only one caller content instance while overflow opens, changes layout, and closes", async () => {
  const person: StageItem = { kind: "participant", id: "person", participant: { id: "person", displayName: "Nora" } };
  const items: StageItem[] = [person, { kind: "screen-share", id: "share", participant: person.participant }, { kind: "whiteboard", id: "whiteboard" }];
  const live = new Map<string, number>();
  const mounts = new Map<string, number>();
  let peak = 0;
  function Resource({ id }: { readonly id: string }) {
    useLayoutEffect(() => {
      mounts.set(id, (mounts.get(id) ?? 0) + 1);
      live.set(id, (live.get(id) ?? 0) + 1);
      peak = Math.max(peak, live.get(id) ?? 0);
      return () => {
        live.set(id, (live.get(id) ?? 0) - 1);
      };
    }, [id]);
    return <video data-resource={id} />;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (maxPerPage: number) => act(async () => root.render(<Stage items={items} layout="grid" maxPerPage={maxPerPage} generatedAvatars={false} animate={false} renderContentTile={(item) => <Resource id={item.id} />} renderPrimaryContent={(item) => <Resource id={item.id} />} />));
  try {
    await render(1);
    const share = container.querySelector('[data-resource="share"]');
    const board = container.querySelector('[data-resource="whiteboard"]');
    expect(share).not.toBeNull();
    expect(board).not.toBeNull();
    const open = async () => {
      const more = container.querySelector<HTMLButtonElement>("[data-stage-item='stage:more']");
      if (!more) throw new Error("Missing content overflow button");
      await act(async () => more.click());
      expect(container.querySelector("[role=dialog]")).not.toBeNull();
    };
    const close = async () => {
      const dialog = container.querySelector("[role=dialog]");
      if (!dialog) throw new Error("Missing content overflow dialog");
      await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })));
      expect(container.querySelector("[role=dialog]")).toBeNull();
    };
    const preserved = () => {
      expect(peak).toBe(1);
      expect([...live.values()]).toEqual([1, 1]);
      expect([...mounts.values()]).toEqual([1, 1]);
      expect(container.querySelector('[data-resource="share"]')).toBe(share);
      expect(container.querySelector('[data-resource="whiteboard"]')).toBe(board);
    };
    await open();
    expect(container.querySelector("[role=dialog]")?.querySelectorAll("[data-resource]")).toHaveLength(2);
    preserved();
    await close();
    preserved();
    await open();
    await render(10);
    preserved();
    await close();
    preserved();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
  expect([...live.values()]).toEqual([0, 0]);
});
