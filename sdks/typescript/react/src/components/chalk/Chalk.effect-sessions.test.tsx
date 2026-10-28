// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Chalk } from "./Chalk";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";

vi.mock("../space-view/SpaceView", () => ({ SpaceView: () => <div>Live Space</div> }));

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("forgets a handled host terminal state when the host clears and later repeats it", async () => {
  const snapshot = createSnapshot([]);
  const client = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "live" } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const committed: (string | null | undefined)[] = [];
  function View({ terminalState }: { terminalState?: "full" }) {
    useLayoutEffect(() => {
      committed.push(container.querySelector("[data-chalk-status]")?.getAttribute("data-chalk-status"));
    });
    return <Chalk client={client} terminalState={terminalState} features={{ sounds: false }} />;
  }
  const render = (terminalState?: "full") => act(async () => root.render(<View terminalState={terminalState} />));
  try {
    await render("full");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Try again"));
    if (!retry) throw new Error("Missing rejoin action");
    await act(async () => retry.click());
    expect(container.querySelector("[data-chalk-status]")).toBeNull();
    await render();
    committed.length = 0;
    await render("full");
    expect(committed).toEqual(["full"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it("does not leave or dispose a host-owned client when it is replaced", async () => {
  const snapshot = createSnapshot([]);
  const first = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "left", episodeEnded: true } });
  const next = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "left" } });
  const leave = vi.spyOn(first, "leave"),
    dispose = vi.spyOn(first, "dispose");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Chalk client={first} features={{ sounds: false }} />));
    expect(container.querySelector("[data-chalk-status]")?.getAttribute("data-chalk-status")).toBe("episode-ended");
    await act(async () => root.render(<Chalk client={next} features={{ sounds: false }} />));
    expect(container.querySelector("[data-chalk-status]")?.getAttribute("data-chalk-status")).toBe("left");
    expect(leave).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    first.dispose();
    next.dispose();
  }
});
