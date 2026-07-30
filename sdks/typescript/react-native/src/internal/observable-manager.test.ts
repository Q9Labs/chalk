import { describe, expect, it, vi } from "vitest";

import { ObservableManager } from "./observable-manager";

class TestManager extends ObservableManager<{ readonly count: number; readonly label: string }> {
  patch(patch: Partial<{ readonly count: number; readonly label: string }>): void {
    this.patchState(patch);
  }

  replace(state: { readonly count: number; readonly label: string }): void {
    this.replaceState(state);
  }
}

describe("ObservableManager", () => {
  it("publishes immutable replacement snapshots and honors unsubscription", () => {
    const initial = { count: 0, label: "initial" };
    const manager = new TestManager(initial);
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);

    manager.replace(initial);
    expect(listener).not.toHaveBeenCalled();

    manager.patch({ count: 1 });
    expect(manager.getState()).toEqual({ count: 1, label: "initial" });
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    manager.patch({ label: "done" });
    expect(listener).toHaveBeenCalledOnce();
    expect(manager.getState()).toEqual({ count: 1, label: "done" });
  });
});
