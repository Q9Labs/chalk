import { describe, expect, it, vi } from "vitest";
import { createNativeMeetingPageStore } from "./native-meeting-page-store";

describe("createNativeMeetingPageStore", () => {
  it("keeps a non-negative page and notifies subscribers when it changes", () => {
    const store = createNativeMeetingPageStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setPage(2);
    store.setPage(2);
    store.clampToPageCount(1);

    expect(store.getSnapshot()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.setPage(3);

    expect(store.getSnapshot()).toBe(3);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
