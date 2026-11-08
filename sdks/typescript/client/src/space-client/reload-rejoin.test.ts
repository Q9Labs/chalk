import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readReloadRejoin, reloadRejoinLifetimeMs, reloadRejoinStorageKey, writeReloadRejoin } from "./reload-rejoin";

const marker = { space: "design-lab", episodeId: "episode-1", participantId: "participant-1", participantGeneration: 1, arrivalHandle: "arrival-1", mediaProof: "proof", displayName: "Ada", microphone: false, camera: false };
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
describe("reload recovery", () => {
  beforeEach(() => vi.stubGlobal("window", { name: "" }));
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("preserves microphone=%s camera=%s and consumes the hint once", (microphone, camera) => {
    const tab = storage();
    writeReloadRejoin(tab, { ...marker, microphone, camera }, 1000);
    expect(readReloadRejoin(tab, marker.space, 1001)).toMatchObject({ ...marker, microphone, camera });
    expect(readReloadRejoin(tab, marker.space, 1001)).toBeNull();
  });
  it("expires after two minutes and refuses other Spaces or corrupt data", () => {
    const tab = storage();
    writeReloadRejoin(tab, marker, 1000);
    expect(readReloadRejoin(tab, marker.space, 1000 + reloadRejoinLifetimeMs)).toBeNull();
    writeReloadRejoin(tab, marker, 1000);
    expect(readReloadRejoin(tab, "other-space", 1001)).toBeNull();
    tab.setItem(reloadRejoinStorageKey, "{}");
    expect(readReloadRejoin(tab, marker.space, 1001)).toBeNull();
  });
  it("ignores an opener's copied marker without consuming the opener's own recovery", () => {
    const opener = storage();
    writeReloadRejoin(opener, marker, 1000);
    const encoded = opener.getItem(reloadRejoinStorageKey);
    if (!encoded) throw new Error("Missing reload marker");
    const opened = storage();
    opened.setItem(reloadRejoinStorageKey, encoded);
    const openerWindow = globalThis.window;
    // window.open copies sessionStorage, but creates a separate window.name.
    vi.stubGlobal("window", { name: "" });
    expect(readReloadRejoin(opened, marker.space, 1001)).toBeNull();
    expect(opened.getItem(reloadRejoinStorageKey)).toBeNull();
    vi.stubGlobal("window", openerWindow);
    expect(readReloadRejoin(opener, marker.space, 1001)).toMatchObject(marker);
  });
  it("does not trust legacy markers or a window name owned by the embedding app", () => {
    const tab = storage();
    tab.setItem(reloadRejoinStorageKey, JSON.stringify({ ...marker, version: 1, expiresAt: 2000 }));
    expect(readReloadRejoin(tab, marker.space, 1001)).toBeNull();
    writeReloadRejoin(tab, marker, 1000);
    vi.stubGlobal("window", { name: "app-frame" });
    expect(readReloadRejoin(tab, marker.space, 1001)).toBeNull();
    expect(() => writeReloadRejoin(tab, marker, 1000)).toThrow("tab identity");
    expect(window.name).toBe("app-frame");
  });
});
