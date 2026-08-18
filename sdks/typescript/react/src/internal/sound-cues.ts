import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { CHALK_SOUND_ASSETS } from "@q9labsai/chalk-ui/assets";

export type SoundCue = keyof typeof CHALK_SOUND_ASSETS;

/** Cues raised by a snapshot change; the player decides whether they are audible. */
export const SNAPSHOT_SOUND_CUES = ["join", "leave", "message", "hand-raise", "reaction"] as const satisfies readonly SoundCue[];

/** Two cues of the same kind closer than this are collapsed into one so a burst of joins does not stutter. */
export const CUE_THROTTLE_MS = 400;

function idsOf<T>(items: readonly T[], id: (item: T) => string): Set<string> {
  return new Set(items.map(id));
}

/**
 * Cues that a snapshot transition should play for the local participant. Ignores anything the
 * local participant did (own messages, own reactions, own hand) and the initial roster and
 * history load, since those are not events for the person watching.
 */
export function diffSoundCues(previous: SpaceSnapshot, next: SpaceSnapshot): readonly SoundCue[] {
  const cues: SoundCue[] = [];
  const selfId = next.self.participantId;
  const wasLive = previous.connection.status === "live";
  const isLive = next.connection.status === "live";
  if (!isLive) return cues;

  if (wasLive && previous.participants.roster !== next.participants.roster) {
    const before = idsOf(previous.participants.roster, (p) => p.participantId);
    const after = idsOf(next.participants.roster, (p) => p.participantId);
    if ([...after].some((id) => id !== selfId && !before.has(id))) cues.push("join");
    if ([...before].some((id) => id !== selfId && !after.has(id))) cues.push("leave");
    const raisedBefore = new Set(previous.participants.roster.filter((p) => p.handRaised).map((p) => p.participantId));
    if (next.participants.roster.some((p) => p.handRaised && p.participantId !== selfId && !raisedBefore.has(p.participantId))) cues.push("hand-raise");
  }

  if (previous.chat.status === "ready" && next.chat.status === "ready" && previous.chat.messages !== next.chat.messages) {
    const seen = idsOf(previous.chat.messages, (m) => m.messageId);
    if (next.chat.messages.some((m) => m.participantId !== selfId && !seen.has(m.messageId))) cues.push("message");
  }

  if (wasLive && previous.reactions.active !== next.reactions.active) {
    const seen = idsOf(previous.reactions.active, (r) => r.eventId);
    if (next.reactions.active.some((r) => r.participantId !== selfId && !seen.has(r.eventId))) cues.push("reaction");
  }

  return cues;
}

export interface SoundPlayer {
  readonly play: (cue: SoundCue) => void;
  readonly dispose: () => void;
}

/** Picks the Opus file when the browser can decode it, otherwise the MP3. */
export function soundSourceFor(cue: SoundCue, canPlay: (mimeType: string) => boolean): string {
  const asset = CHALK_SOUND_ASSETS[cue];
  return canPlay(asset.opus.mimeType) ? asset.opus.url : asset.mp3.url;
}

/**
 * Lazily creates one `HTMLAudioElement` per cue and replays it from the start. Playback failures
 * (autoplay policy before the first gesture, network) are reported through `onError` and never thrown.
 */
export function createSoundPlayer({ volume = 0.6, onError }: { volume?: number; onError?: (cue: SoundCue, cause: unknown) => void } = {}): SoundPlayer {
  const elements = new Map<SoundCue, HTMLAudioElement>();
  const lastPlayed = new Map<SoundCue, number>();
  const probe = typeof Audio === "undefined" ? null : new Audio();
  const canPlay = (mimeType: string) => probe !== null && probe.canPlayType(mimeType) !== "";

  return {
    play: (cue) => {
      if (probe === null) return;
      const now = Date.now();
      if (now - (lastPlayed.get(cue) ?? Number.NEGATIVE_INFINITY) < CUE_THROTTLE_MS) return;
      lastPlayed.set(cue, now);
      let element = elements.get(cue);
      if (!element) {
        element = new Audio(soundSourceFor(cue, canPlay));
        element.preload = "auto";
        element.volume = volume;
        elements.set(cue, element);
      }
      element.currentTime = 0;
      element.play().catch((cause: unknown) => onError?.(cue, cause));
    },
    dispose: () => {
      for (const element of elements.values()) {
        element.pause();
        element.removeAttribute("src");
      }
      elements.clear();
    },
  };
}
