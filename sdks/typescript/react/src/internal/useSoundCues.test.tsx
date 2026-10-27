// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChalkProvider } from "../bindings/context";
import { createPreviewClient, createSnapshot } from "../test-support/preview-client";
import { useSoundCues } from "./useSoundCues";
import type { Participant, SpaceSnapshot } from "@q9labsai/chalk-client";

it("synthesizes a quiet reaction tone only while Sounds is enabled", async () => {
  const start = vi.fn();
  const stop = vi.fn();
  const volume = vi.fn();
  const close = vi.fn();
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = {};
      close = close;
      createOscillator() {
        return { type: "sine", frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (gain: GainNode) => gain, start, stop, disconnect: vi.fn() };
      }
      createGain() {
        return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: volume, exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
      }
    },
  );
  const base = createSnapshot();
  const client = createPreviewClient({ ...base, connection: { ...base.connection, status: "live" }, self: { ...base.self, participantId: "self" } });
  const container = document.createElement("div");
  const root = createRoot(container);
  function Sounds({ enabled }: { enabled: boolean }) {
    useSoundCues(enabled);
    return null;
  }
  const react = async (eventId: string) =>
    act(async () => client.updateSnapshot((snapshot) => ({ ...snapshot, reactions: { active: [...snapshot.reactions.active, { eventId, participantId: "peer", displayName: "Nora", reaction: "👏", occurredAt: "2026-10-19T00:00:00Z", expiresAt: "2026-10-19T00:01:00Z" }] } })));
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <Sounds enabled />
        </ChalkProvider>,
      ),
    );
    await react("first");
    expect(start).toHaveBeenCalledOnce();
    expect(stop.mock.calls[0]?.[0]).toBeLessThanOrEqual(0.3);
    expect(volume.mock.calls[0]?.[0]).toBeGreaterThan(0);
    expect(volume.mock.calls[0]?.[0]).toBeLessThanOrEqual(0.05);
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <Sounds enabled={false} />
        </ChalkProvider>,
      ),
    );
    await react("muted");
    expect(start).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <Sounds enabled />
        </ChalkProvider>,
      ),
    );
    expect(start).toHaveBeenCalledOnce();
    await react("third");
    expect(start).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    client.dispose();
    vi.unstubAllGlobals();
  }
  expect(close).toHaveBeenCalledOnce();
});

it("chimes for new remote joins, not self, initial rosters, reconnects, or bursts", async () => {
  const play = vi.fn();
  const createPlayer = () => ({ play, dispose: vi.fn() });
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const base = createSnapshot();
  const client = createPreviewClient({ ...base, connection: { ...base.connection, status: "joining" }, self: { ...base.self, participantId: "self" } });
  const root = createRoot(document.createElement("div"));
  function Sounds({ enabled }: { enabled: boolean }) {
    useSoundCues(enabled, createPlayer);
    return null;
  }
  const render = (enabled: boolean) =>
    act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <Sounds enabled={enabled} />
        </ChalkProvider>,
      ),
    );
  const update = (roster: readonly string[], status: SpaceSnapshot["connection"]["status"] = "live") =>
    act(async () =>
      client.updateSnapshot((snapshot) => ({
        ...snapshot,
        connection: { ...snapshot.connection, status },
        participants: { ...snapshot.participants, roster: roster.map(participant) },
      })),
    );
  const joins = () => play.mock.calls.filter(([cue]) => cue === "join");
  try {
    await render(true);
    await update(["existing"]);
    await update(["existing", "self"]);
    expect(joins()).toHaveLength(0);
    await update(["existing", "self", "remote"]);
    expect(joins()).toHaveLength(1);
    now = 1000;
    await update(["existing", "self", "remote", "burst-1", "burst-2"]);
    expect(joins()).toHaveLength(1);
    now = 3000;
    await update(["existing", "self", "remote", "burst-1", "burst-2", "later"]);
    expect(joins()).toHaveLength(2);
    now = 6000;
    await update(["self", "remote", "burst-1", "burst-2", "later"]);
    await update(["existing", "self", "remote", "burst-1", "burst-2", "later"]);
    expect(joins()).toHaveLength(2);
    await update([], "reconnecting");
    await update(["existing", "self", "remote", "joined-while-offline"]);
    await update(["existing", "self", "remote", "joined-while-offline"]);
    expect(joins()).toHaveLength(2);
    await render(false);
    await update(["self", "muted-join"]);
    await render(true);
    await update(["self"]);
    await update(["self", "muted-join"]);
    expect(joins()).toHaveLength(2);
    await update(["self", "muted-join", "new-join"]);
    expect(joins()).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
    client.dispose();
    clock.mockRestore();
  }
});

function participant(participantId: string): Participant {
  return { participantId, displayName: participantId, role: "member", eligibleRoles: [], capabilities: [], handRaised: false, media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" }, presence: { state: "connected", speaking: false, activeSpeaker: false } };
}
