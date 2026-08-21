// @vitest-environment happy-dom

import type { Participant, SpaceSnapshot } from "@q9labsai/chalk-client";
import { act, renderHook } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "../bindings/context";
import { createSnapshot, createTestClient } from "../test-support/test-client";
import { useSoundCues } from "./useSoundCues";

function person(participantId: string): Participant {
  return { participantId, displayName: participantId, role: "member", eligibleRoles: [], capabilities: [], handRaised: false, media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" }, presence: { state: "connected", speaking: false, activeSpeaker: false } };
}

function live(roster: readonly Participant[], speaker: string | null = null): SpaceSnapshot {
  const base = createSnapshot();
  return {
    ...base,
    connection: { ...base.connection, status: "live" },
    self: { ...base.self, participantId: "me" },
    participants: { roster, admissionQueue: [] },
    media: { ...base.media, selection: { ...base.media.selection, speaker } },
  };
}

function wrapper(client: ReturnType<typeof createTestClient>) {
  return ({ children }: PropsWithChildren) => createElement(ChalkProvider, { client }, children);
}

function createPlayer() {
  return { play: vi.fn(), dispose: vi.fn() };
}

describe("useSoundCues", () => {
  it("subscribes to snapshot changes, plays incoming cues, and disposes on unmount", () => {
    const client = createTestClient(live([person("me"), person("alice")]));
    const player = createPlayer();
    const createSoundPlayer = vi.fn((_options: { readonly outputDeviceId?: string }) => player);
    const { unmount } = renderHook(() => useSoundCues(true, createSoundPlayer), { wrapper: wrapper(client) });

    act(() => {
      client.setSnapshot(live([person("me"), person("alice"), person("bob")]));
    });

    expect(player.play).toHaveBeenCalledWith("join");

    unmount();
    expect(player.dispose).toHaveBeenCalledOnce();

    act(() => {
      client.setSnapshot(live([person("me"), person("alice"), person("bob"), person("carol")]));
    });
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it("passes the selected output device and recreates the player when it changes", () => {
    const client = createTestClient(live([person("me"), person("alice")], "speaker-1"));
    const firstPlayer = createPlayer();
    const secondPlayer = createPlayer();
    const players = [firstPlayer, secondPlayer];
    const createSoundPlayer = vi.fn((_options: { readonly outputDeviceId?: string }) => players.shift() ?? secondPlayer);
    const { rerender, unmount } = renderHook(({ enabled }) => useSoundCues(enabled, createSoundPlayer), { initialProps: { enabled: true }, wrapper: wrapper(client) });

    expect(createSoundPlayer).toHaveBeenNthCalledWith(1, { outputDeviceId: "speaker-1" });

    act(() => {
      client.setSnapshot(live([person("me"), person("alice")], "speaker-2"));
    });

    expect(createSoundPlayer).toHaveBeenNthCalledWith(2, { outputDeviceId: "speaker-2" });
    expect(firstPlayer.dispose).toHaveBeenCalledOnce();

    rerender({ enabled: false });
    expect(secondPlayer.dispose).toHaveBeenCalledOnce();
    unmount();
  });

  it("does not subscribe or play while disabled, then starts on enable", () => {
    const client = createTestClient(live([person("me"), person("alice")]));
    const player = createPlayer();
    const createSoundPlayer = vi.fn((_options: { readonly outputDeviceId?: string }) => player);
    const { rerender } = renderHook(({ enabled }) => useSoundCues(enabled, createSoundPlayer), { initialProps: { enabled: false }, wrapper: wrapper(client) });

    expect(createSoundPlayer).not.toHaveBeenCalled();
    act(() => {
      client.setSnapshot(live([person("me"), person("alice"), person("bob")]));
    });
    expect(player.play).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(createSoundPlayer).toHaveBeenCalledWith({ outputDeviceId: undefined });

    act(() => {
      client.setSnapshot(live([person("me"), person("alice"), person("bob"), person("carol")]));
    });
    expect(player.play).toHaveBeenCalledWith("join");
  });
});
