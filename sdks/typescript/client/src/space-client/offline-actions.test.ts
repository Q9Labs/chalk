import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import type { ConnectionLifecycleCapability } from "../connection";
import { makeOfflineActions } from "./offline-actions";
import { SpaceStore } from "./store";

function setup() {
  let state = "live";
  let nextId = 0;
  const listeners = new Set<() => void>();
  const connection = {
    getSnapshot: () => ({ state }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createId: () => `action-${++nextId}`,
    nowUnsafe: () => 1_000,
  } as unknown as ConnectionLifecycleCapability;
  const store = new SpaceStore();
  const scope = Effect.runSync(Scope.make());
  const offline = Effect.runSync(makeOfflineActions({ connection, store }).pipe(Scope.provide(scope)));
  return {
    offline,
    store,
    setState: (next: string) => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("OfflineActions", () => {
  it("does not hold actions while the connection is live", () => {
    const { offline } = setup();
    expect(offline.hold({ kind: "hand_raise" }, () => Effect.void)).toBeNull();
  });

  it("holds actions while reconnecting and sends them when live with the default policy", async () => {
    const { offline, store, setState } = setup();
    setState("reconnecting");
    const ran: string[] = [];
    const held = offline.hold({ kind: "chat_message", text: "hello" }, () => Effect.sync(() => ran.push("chat")));
    expect(held).not.toBeNull();
    const result = Effect.runPromise(held!);
    await settled();
    expect(store.getSnapshot().offline.pending).toMatchObject([{ kind: "chat_message", text: "hello" }]);
    expect(ran).toEqual([]);
    setState("live");
    await result;
    expect(ran).toEqual(["chat"]);
    expect(store.getSnapshot().offline.pending).toEqual([]);
  });

  it("waits for a decision when the policy is ask, then sends on request", async () => {
    const { offline, store, setState } = setup();
    await Effect.runPromise(offline.setPolicy("ask"));
    setState("reconnecting");
    const ran: string[] = [];
    const result = Effect.runPromise(offline.hold({ kind: "hand_raise" }, () => Effect.sync(() => ran.push("hand")))!);
    setState("live");
    await settled();
    expect(store.getSnapshot().offline).toMatchObject({ decisionNeeded: true, pending: [{ kind: "hand_raise" }] });
    expect(offline.hold({ kind: "hand_lower" }, () => Effect.void)).not.toBeNull();
    await Effect.runPromise(offline.send());
    await result;
    expect(ran).toEqual(["hand"]);
    expect(store.getSnapshot().offline.decisionNeeded).toBe(false);
  });

  it("discards held actions with offline.discarded and never runs them", async () => {
    const { offline, store, setState } = setup();
    await Effect.runPromise(offline.setPolicy("ask"));
    setState("reconnecting");
    let ran = false;
    const exit = Effect.runPromiseExit(offline.hold({ kind: "chat_message", text: "old" }, () => Effect.sync(() => (ran = true)))!);
    setState("live");
    await settled();
    await Effect.runPromise(offline.discard());
    const outcome = await exit;
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(JSON.stringify(outcome)).toContain("offline.discarded");
    expect(ran).toBe(false);
    expect(store.getSnapshot().offline.pending).toEqual([]);
  });

  it("applies a remembered send policy immediately when a decision is already waiting", async () => {
    const { offline, store, setState } = setup();
    await Effect.runPromise(offline.setPolicy("ask"));
    setState("reconnecting");
    const result = Effect.runPromise(offline.hold({ kind: "hand_raise" }, () => Effect.void)!);
    setState("live");
    await settled();
    await Effect.runPromise(offline.setPolicy("send"));
    await result;
    expect(store.getSnapshot().offline).toMatchObject({ pending: [], decisionNeeded: false, policy: "send" });
  });

  it("discards held actions when the connection ends instead of recovering", async () => {
    const { offline, setState } = setup();
    setState("reconnecting");
    const exit = Effect.runPromiseExit(offline.hold({ kind: "hand_raise" }, () => Effect.void)!);
    setState("failed");
    expect(Exit.isFailure(await exit)).toBe(true);
  });
});
