import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import type { ConnectionLifecycleCapability } from "../connection";
import { makeChatController } from "./chat-controller";
import { makeOfflineActions } from "./offline-actions";
import { SpaceStore } from "./store";

const subject = { tenantId: "tenant", spaceId: "space", episodeId: "episode", participantId: "participant", participantGeneration: 1 };
const storage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: values.set.bind(values),
    removeItem: values.delete.bind(values),
  };
};
function setup(options: { storage?: ReturnType<typeof storage>; subject?: typeof subject; now?: number; initialState?: string; recoverable?: boolean } = {}) {
  let state = options.initialState ?? "live";
  let nextId = 0;
  const sent: unknown[] = [];
  const listeners = new Set<() => void>();
  const connection = {
    getSnapshot: () => ({ state, subject: options.subject ?? subject, failure: state === "failed" ? { code: options.recoverable ? "access_unavailable" : "episode_ended", recoverable: options.recoverable ?? false } : null }),
    runCommand: (run: (ports: unknown) => Effect.Effect<unknown>) =>
      run({
        sync: {
          sendChatMessage: async (input: unknown) => {
            sent.push(input);
          },
          setHandRaised: async (raised: boolean) => {
            sent.push(raised);
          },
        },
      }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribePorts: () => () => {},
    createId: () => `action-${++nextId}`,
    nowUnsafe: () => options.now ?? 1_000,
  } as unknown as ConnectionLifecycleCapability;
  const store = new SpaceStore();
  const scope = Effect.runSync(Scope.make());
  const offline = Effect.runSync(makeOfflineActions({ connection, store, storage: options.storage, storageKey: "test-queue" }).pipe(Scope.provide(scope)));
  return {
    offline,
    store,
    sent,
    connection,
    scope,
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

describe("held actions across reload", () => {
  async function queue(saved: ReturnType<typeof storage>) {
    const first = setup({ storage: saved });
    first.setState("reconnecting");
    void Effect.runPromiseExit(
      first.offline.hold({ kind: "chat_message", text: "hello", clientMessageId: "message-1", attachments: [] }, () =>
        Effect.sync(() => {
          first.sent.push("hello");
          expect(saved.values.size).toBe(0);
        }),
      )!,
    );
    await settled();
    return first;
  }
  it("persists the real chat controller's request key and attachment descriptors", async () => {
    const saved = storage();
    const first = setup({ storage: saved });
    const chat = Effect.runSync(makeChatController({ connection: first.connection, store: first.store, offline: first.offline }).pipe(Scope.provide(first.scope)));
    first.setState("reconnecting");
    const attachments = [{ attachmentId: "11111111-1111-4111-8111-111111111111", fileName: "sketch.png", mimeType: "image/png" as const, byteLength: 100 }];
    void Effect.runPromiseExit(chat.send({ text: "sketch", attachments }));
    await settled();
    const second = setup({ storage: saved });
    second.setState("live");
    expect(second.store.getSnapshot().offline.pending).toMatchObject([{ text: "sketch" }]);
    await Effect.runPromise(second.offline.send());
    await settled();
    expect(second.sent).toEqual([{ text: "sketch", attachments, clientMessageId: "action-1" }]);
  });
  it("restores when constructed with an already-live connection", async () => {
    const saved = storage();
    await queue(saved);
    const second = setup({ storage: saved });
    expect(second.store.getSnapshot().offline).toMatchObject({ decisionNeeded: true, pending: [{ text: "hello" }] });
  });
  it("restores a held chat and asks once the same Episode is live", async () => {
    const saved = storage();
    await queue(saved);
    const second = setup({ storage: saved });
    second.setState("live");
    expect(second.store.getSnapshot().offline).toMatchObject({ decisionNeeded: true, pending: [{ text: "hello" }] });
    await Effect.runPromise(second.offline.send());
    await settled();
    expect(second.sent).toEqual([{ text: "hello", clientMessageId: "message-1", attachments: [] }]);
  });
  it.each(["tenantId", "spaceId", "episodeId", "participantId", "participantGeneration"] as const)("drops a %s mismatch with a plain notice", async (field) => {
    const saved = storage();
    await queue(saved);
    const second = setup({ storage: saved, subject: { ...subject, [field]: field === "participantGeneration" ? 2 : "different" } });
    second.setState("live");
    expect(second.store.getSnapshot().offline.pending).toEqual([]);
    expect(second.store.getSnapshot().offline.notice).toContain("not sent");
    expect(second.sent).toEqual([]);
    expect(saved.values.size).toBe(0);
  });
  it("drops actions older than 24 hours", async () => {
    const saved = storage();
    await queue(saved);
    const second = setup({ storage: saved, now: 1_000 + 86_400_000 });
    second.setState("live");
    expect(second.store.getSnapshot().offline.pending).toEqual([]);
    expect(second.store.getSnapshot().offline.notice).toContain("expired");
  });
  it("never replays an action after send then reload", async () => {
    const saved = storage();
    const first = await queue(saved);
    first.setState("live");
    await settled();
    expect(first.sent).toEqual(["hello"]);
    const second = setup({ storage: saved });
    second.setState("live");
    expect(second.store.getSnapshot().offline.pending).toEqual([]);
    expect(second.sent).toEqual([]);
  });
  it("keeps saved actions through a recoverable offline startup failure", async () => {
    const saved = storage();
    await queue(saved);
    const second = setup({ storage: saved, initialState: "joining", recoverable: true });
    second.setState("failed");
    expect(saved.values.size).toBe(1);
    second.setState("live");
    expect(second.store.getSnapshot().offline).toMatchObject({ decisionNeeded: true, pending: [{ text: "hello" }] });
    expect(second.sent).toEqual([]);
  });
  it("keeps in-memory actions through a recoverable failure", async () => {
    const saved = storage();
    const first = setup({ storage: saved, recoverable: true });
    first.setState("reconnecting");
    void Effect.runPromiseExit(first.offline.hold({ kind: "hand_raise" }, () => Effect.void)!);
    await settled();
    first.setState("failed");
    expect(first.store.getSnapshot().offline.pending).toHaveLength(1);
    expect(saved.values.size).toBe(1);
  });
  it("drops saved actions when rejoin reports an ended Episode", async () => {
    const saved = storage();
    await queue(saved);
    const second = setup({ storage: saved });
    second.setState("failed");
    expect(saved.values.size).toBe(0);
    expect(second.store.getSnapshot().offline.notice).toContain("Episode ended");
    expect(second.sent).toEqual([]);
  });
  it("preserves held actions on disposal and never sends during disposal", async () => {
    const saved = storage();
    const first = await queue(saved);
    first.offline.dispose();
    await settled();
    expect(first.sent).toEqual([]);
    const second = setup({ storage: saved });
    second.setState("live");
    expect(second.store.getSnapshot().offline.pending).toHaveLength(1);
  });
  it("does not resend a restored action on another reload", async () => {
    const saved = storage();
    await queue(saved);
    const second = setup({ storage: saved });
    second.setState("live");
    await Effect.runPromise(second.offline.send());
    await settled();
    expect(second.sent).toHaveLength(1);
    const third = setup({ storage: saved });
    third.setState("live");
    expect(third.sent).toEqual([]);
    expect(third.store.getSnapshot().offline.pending).toEqual([]);
  });
  it.each(["{broken", '{"version":99}', '{"version":1,"actions":[null]}'])("ignores corrupt or unknown data: %s", (raw) => {
    const saved = storage();
    saved.setItem("test-queue", raw);
    const second = setup({ storage: saved });
    expect(() => second.setState("live")).not.toThrow();
    expect(second.store.getSnapshot().offline.pending).toEqual([]);
  });
});
