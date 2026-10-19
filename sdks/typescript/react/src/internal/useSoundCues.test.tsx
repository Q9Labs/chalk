// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChalkProvider } from "../bindings/context";
import { createPreviewClient, createSnapshot } from "../test-support/preview-client";
import { useSoundCues } from "./useSoundCues";

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
    window.dispatchEvent(new MouseEvent("click"));
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
