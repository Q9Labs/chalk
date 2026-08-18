import type { Participant, SpaceSnapshot } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

import { createSnapshot } from "../test-support/preview-client";
import { CUE_THROTTLE_MS, createSoundPlayer, diffSoundCues, soundSourceFor } from "./sound-cues";

function person(participantId: string, handRaised = false): Participant {
  return { participantId, displayName: participantId, role: "member", eligibleRoles: [], capabilities: [], handRaised, media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" }, presence: { state: "connected", speaking: false, activeSpeaker: false } };
}

function live(roster: readonly Participant[]): SpaceSnapshot {
  const base = createSnapshot();
  return { ...base, connection: { ...base.connection, status: "live" }, self: { ...base.self, participantId: "me" }, participants: { roster, admissionQueue: [] } };
}

const message = (messageId: string, participantId: string) => ({ messageId, clientMessageId: messageId, sequence: 1, participantId, displayName: participantId, text: "hi", attachments: [], createdAt: "2026-08-18T10:00:00.000Z" });
const reaction = (eventId: string, participantId: string) => ({ eventId, participantId, displayName: participantId, reaction: "🎉" as const, occurredAt: "2026-08-18T10:00:00.000Z", expiresAt: "2026-08-18T10:00:05.000Z" });

describe("diffSoundCues", () => {
  it("plays join and leave for other participants only", () => {
    const before = live([person("me"), person("a")]);
    expect(diffSoundCues(before, live([person("me"), person("a"), person("b")]))).toEqual(["join"]);
    expect(diffSoundCues(before, live([person("me")]))).toEqual(["leave"]);
    expect(diffSoundCues(live([person("a")]), live([person("me"), person("a")]))).toEqual([]);
  });

  it("stays quiet for the initial roster load and while not live", () => {
    const idle = createSnapshot();
    expect(diffSoundCues(idle, live([person("me"), person("a"), person("b")]))).toEqual([]);
    expect(diffSoundCues(live([person("me")]), { ...live([person("me"), person("a")]), connection: { status: "reconnecting", episode: null, lastError: null } })).toEqual([]);
  });

  it("plays hand-raise when someone else raises a hand", () => {
    const before = live([person("me"), person("a")]);
    expect(diffSoundCues(before, live([person("me"), person("a", true)]))).toEqual(["hand-raise"]);
    expect(diffSoundCues(before, live([person("me", true), person("a")]))).toEqual([]);
    expect(diffSoundCues(live([person("me"), person("a", true)]), live([person("me"), person("a")]))).toEqual([]);
  });

  it("plays message for new messages from others once history is ready", () => {
    const ready = (messages: ReturnType<typeof message>[], status: "loading" | "ready" = "ready"): SpaceSnapshot => {
      const base = live([person("me"), person("a")]);
      return { ...base, chat: { ...base.chat, status, messages } };
    };
    expect(diffSoundCues(ready([]), ready([message("m1", "a")]))).toEqual(["message"]);
    expect(diffSoundCues(ready([]), ready([message("m1", "me")]))).toEqual([]);
    expect(diffSoundCues(ready([], "loading"), ready([message("m1", "a")]))).toEqual([]);
  });

  it("plays reaction for incoming reactions from others", () => {
    const base = live([person("me"), person("a")]);
    const withReaction = (id: string, from: string): SpaceSnapshot => ({ ...base, reactions: { active: [reaction(id, from)] } });
    expect(diffSoundCues(base, withReaction("r1", "a"))).toEqual(["reaction"]);
    expect(diffSoundCues(base, withReaction("r1", "me"))).toEqual([]);
    expect(diffSoundCues(withReaction("r1", "a"), withReaction("r1", "a"))).toEqual([]);
  });
});

describe("soundSourceFor", () => {
  it("prefers opus when playable and falls back to mp3", () => {
    expect(soundSourceFor("join", () => true)).toMatch(/\.opus$/);
    expect(soundSourceFor("join", () => false)).toMatch(/\.mp3$/);
  });
});

describe("createSoundPlayer", () => {
  it("throttles repeated cues and reports playback failures instead of throwing", () => {
    vi.useFakeTimers();
    const play = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
    class FakeAudio {
      preload = "";
      volume = 1;
      currentTime = 0;
      constructor(public src = "") {}
      canPlayType = () => "probably";
      play = play;
      pause = vi.fn();
      removeAttribute = vi.fn();
    }
    vi.stubGlobal("Audio", FakeAudio);
    const onError = vi.fn();
    const player = createSoundPlayer({ onError });
    player.play("join");
    player.play("join");
    expect(play).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CUE_THROTTLE_MS + 1);
    player.play("join");
    expect(play).toHaveBeenCalledTimes(2);
    player.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    return vi.waitFor(() => expect(onError).toHaveBeenCalledWith("join", expect.any(Error)));
  });
});
