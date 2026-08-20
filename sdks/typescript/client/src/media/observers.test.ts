import { describe, expect, it } from "vitest";

import { observePublications, subscribeSnapshot } from "./observers";

describe("media observer helpers", () => {
  it("registers a snapshot listener and removes it idempotently", () => {
    const listeners = new Set<() => void>();
    let calls = 0;
    const unsubscribe = subscribeSnapshot(listeners, () => {
      calls += 1;
    });

    for (const listener of listeners) listener();
    expect(calls).toBe(1);

    unsubscribe();
    unsubscribe();
    for (const listener of listeners) listener();
    expect(calls).toBe(1);
    expect(listeners).toHaveLength(0);
  });

  it("emits the current projection immediately and on later notifications", () => {
    const listeners = new Set<() => void>();
    const values: number[] = [];
    let current = 1;
    const unsubscribe = observePublications(
      listeners,
      (value) => values.push(value),
      () => current,
    );

    expect(values).toEqual([1]);
    current = 2;
    for (const listener of listeners) listener();
    expect(values).toEqual([1, 2]);

    unsubscribe();
    current = 3;
    for (const listener of listeners) listener();
    expect(values).toEqual([1, 2]);
  });

  it("propagates an observer callback failure", () => {
    const listeners = new Set<() => void>();
    const failure = new Error("observer failed");

    expect(() =>
      observePublications(
        listeners,
        () => {
          throw failure;
        },
        () => "value",
      ),
    ).toThrow(failure);
  });
});
