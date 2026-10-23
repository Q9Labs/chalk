// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Stage, type StageItem } from "../stage/Stage";
import { ChalkToast } from "../chalk-ui/ChalkToast";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { SpaceView } from "../space-view/SpaceView";

it("returns overflow media to the stage without mounting a replacement", async () => {
  const person: StageItem = { kind: "participant", id: "person", participant: { id: "person", displayName: "Nora" } };
  const items: StageItem[] = [person, { kind: "screen-share", id: "share", participant: person.participant }, { kind: "whiteboard", id: "whiteboard" }];
  let mounts = 0,
    active = 0,
    peak = 0;
  function Media() {
    useLayoutEffect(() => {
      mounts++;
      active++;
      peak = Math.max(peak, active);
      return () => {
        active--;
      };
    }, []);
    return <video data-review-media="share" />;
  }
  const container = document.createElement("main");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Stage items={items} layout="grid" maxPerPage={1} generatedAvatars={false} animate={false} renderContentTile={(item) => (item.id === "share" ? <Media /> : <div>whiteboard</div>)} />));
    await act(async () => container.querySelector<HTMLButtonElement>("[data-stage-item='stage:more']")!.click());
    const video = container.querySelector("[role=dialog] video");
    expect(video).not.toBeNull();
    const beforeClose = mounts;
    await act(async () => container.querySelector("[role=dialog]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })));
    expect(container.querySelector("[role=dialog]")).toBeNull();
    console.log("MEDIA_CLOSE", { beforeClose, afterClose: mounts, active, peak, sameVideo: container.querySelector("[data-stage-item=share] [data-review-media=share]") === video });
    expect(active).toBe(1);
    expect(peak).toBe(1);
    expect(mounts).toBe(beforeClose);
    expect(container.querySelector("[data-stage-item=share] [data-review-media=share]")).toBe(video);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("keeps phone shares beyond the floating cap reachable in overflow", async () => {
  const updates: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.getAttribute("data-testid") !== "stage") return;
        updates.push(() => this.callback([{ target, contentRect: new DOMRectReadOnly(0, 0, 390, 844), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this));
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const participant = { id: "person", displayName: "Nora" };
  const items: StageItem[] = [
    { kind: "whiteboard", id: "board" },
    { kind: "screen-share", id: "share-a", participant },
    { kind: "screen-share", id: "share-b", participant },
    { kind: "participant", id: "person", participant },
  ];
  const container = document.createElement("main");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Stage items={items} layout="focus" pinnedId="board" maxPerPage={2} generatedAvatars={false} animate={false} renderContentTile={(item) => <div data-review-content={item.id}>{item.id}</div>} />));
    await act(async () => updates.forEach((update) => update()));
    expect(container.querySelectorAll("[data-stage-role=float]").length).toBe(2);
    const more = container.querySelector<HTMLButtonElement>("[data-stage-item='stage:more']");
    expect(more).not.toBeNull();
    await act(async () => more!.click());
    expect(container.querySelector("[role=dialog] [data-review-content='share-b']")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("retains live drawing permission updates alongside the offline notice", async () => {
  const base = createSnapshot(["drawWhiteboard"]);
  const warning = "Your expired offline actions were not sent.";
  const client = createPreviewClient({ ...base, connection: { ...base.connection, status: "live" }, offline: { ...base.offline, notice: warning } });
  const container = document.createElement("main");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} onToggleWhiteboard={() => {}} />
        </ChalkProvider>,
      ),
    );
    expect(container.querySelector('[aria-label="Board"]')).not.toBeNull();
    expect(container.textContent).toContain(warning);
    await act(async () => client.updateSnapshot((current) => ({ ...current, whiteboard: { ...current.whiteboard, engine: { ...current.whiteboard.engine, status: "ready" }, access: { ...current.whiteboard.access, policy: "everyone", canDraw: false } } })));
    expect(container.querySelector('[aria-label="Board"]')).toBeNull();
    expect(container.textContent).toContain(warning);
    await act(async () => client.updateSnapshot((current) => ({ ...current, whiteboard: { ...current.whiteboard, access: { ...current.whiteboard.access, canDraw: true } } })));
    expect(container.querySelector('[aria-label="Board"]')).not.toBeNull();
    expect(container.textContent).toContain(warning);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it("announces the next real message once after re-enabling announce", async () => {
  const container = document.createElement("main");
  document.body.append(container);
  const root = createRoot(container);
  const render = (announce: boolean, message: string) => act(async () => root.render(<ChalkToast type="error" message={message} announce={announce} onDismiss={() => {}} />));
  const mutations: string[] = [];
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.type === "childList" || record.type === "characterData")) mutations.push(container.querySelector("[aria-live=assertive]")?.textContent ?? "silent");
  });
  try {
    await render(true, "First failure");
    await render(false, "Silent failure");
    expect(container.querySelector("[aria-live]")).toBeNull();
    await render(true, "Silent failure");
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    await render(true, "Next failure");
    await render(true, "Next failure");
    expect(container.querySelectorAll("[aria-live=assertive]")).toHaveLength(1);
    expect(mutations).toEqual(["Next failure"]);
  } finally {
    observer.disconnect();
    await act(async () => root.unmount());
    container.remove();
  }
});
