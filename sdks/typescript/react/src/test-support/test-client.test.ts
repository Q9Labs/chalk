import { describe, expect, it, vi } from "vitest";

import { createSnapshot, createTestClient } from "./test-client";

describe("createTestClient", () => {
  it("records command calls as inspectable spies", async () => {
    const client = createTestClient();

    await client.media.setMicrophoneEnabled(true);
    await client.join({ displayName: "Test participant" });

    expect(vi.isMockFunction(client.media.setMicrophoneEnabled)).toBe(true);
    expect(client.media.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(client.join).toHaveBeenCalledOnce();
  });

  it("serves its snapshot and notifies subscribers on setSnapshot", () => {
    const initial = createSnapshot();
    const client = createTestClient(initial);
    expect(client.getSnapshot()).toBe(initial);

    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);

    const next = createSnapshot([]);
    client.setSnapshot(next);
    expect(client.getSnapshot()).toBe(next);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    client.setSnapshot(initial);
    expect(listener).toHaveBeenCalledOnce();
  });
});
