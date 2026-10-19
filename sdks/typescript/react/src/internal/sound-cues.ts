import type { SpaceSnapshot } from "@q9labsai/chalk-client";
export type SoundCue = "join" | "leave" | "message" | "hand-raise" | "reaction" | "knock" | "mute" | "unmute" | "recording" | "error";
/** Cues raised by a snapshot change; the player decides whether they are audible. */
export const SNAPSHOT_SOUND_CUES = ["join", "leave", "message", "hand-raise", "reaction", "knock", "mute", "unmute", "recording"] as const satisfies readonly SoundCue[];

export function idsOf<T>(items: readonly T[], id: (item: T) => string): Set<string> {
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
    if (next.participants.roster.some((p) => p.handRaised && !raisedBefore.has(p.participantId))) cues.push("hand-raise");
  }

  if (previous.chat.status === "ready" && next.chat.status === "ready" && previous.chat.messages !== next.chat.messages) {
    const seen = idsOf(previous.chat.messages, (m) => m.messageId);
    if (next.chat.messages.some((m) => m.participantId !== selfId && !seen.has(m.messageId))) cues.push("message");
  }

  if (wasLive && previous.reactions.active !== next.reactions.active) {
    const seen = idsOf(previous.reactions.active, (r) => r.eventId);
    if (next.reactions.active.some((r) => r.participantId !== selfId && !seen.has(r.eventId))) cues.push("reaction");
  }

  if (wasLive && next.participants.admissionQueue.some((request) => !previous.participants.admissionQueue.some((before) => before.requestId === request.requestId))) cues.push("knock");
  if (wasLive && previous.media.local.microphone.state !== next.media.local.microphone.state) {
    if (next.media.local.microphone.state === "enabled") cues.push("unmute");
    if (next.media.local.microphone.state === "disabled") cues.push("mute");
  }
  if (wasLive && previous.recording.current?.status !== "recording" && next.recording.current?.status === "recording") cues.push("recording");
  return cues;
}

export interface SoundPlayer {
  readonly play: (cue: SoundCue) => void;
  readonly dispose: () => void;
}

/** The mockup's tones. A player belongs to one mounted call and closes its context on disposal. */
export function createSoundPlayer({ outputDeviceId }: { readonly outputDeviceId?: string } = {}): SoundPlayer {
  let context: AudioContext | null = null;
  let disposed = false;
  const unlock = () => {
    if (disposed || typeof AudioContext === "undefined") return;
    const created = !context;
    try {
      context ??= new AudioContext();
    } catch {
      // A blocked or exhausted browser audio context can be retried on the next gesture.
      return;
    }
    if (created && outputDeviceId && "setSinkId" in context && typeof context.setSinkId === "function") void Promise.resolve(context.setSinkId(outputDeviceId)).catch(() => undefined);
    if (context.state === "suspended") void context.resume().catch(() => undefined);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("click", unlock, { capture: true });
    window.addEventListener("keydown", unlock, { capture: true });
  }
  const tone = (frequency: number, offset: number, duration: number, volume = 0.07, type: OscillatorType = "sine", to?: number) => {
    if (!context || context.state !== "running") return;
    const oscillator = context.createOscillator(),
      gain = context.createGain(),
      time = context.currentTime + offset;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, time);
    if (to) oscillator.frequency.exponentialRampToValueAtTime(to, time + duration);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(volume, time + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.05);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  };
  const thud = (offset: number) => {
    if (!context) return;
    const length = Math.round(context.sampleRate * 0.07),
      buffer = context.createBuffer(1, length, context.sampleRate),
      data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 4;
    const source = context.createBufferSource(),
      filter = context.createBiquadFilter(),
      gain = context.createGain();
    source.buffer = buffer;
    filter.type = "lowpass";
    filter.frequency.value = 700;
    gain.gain.value = 0.45;
    source.connect(filter).connect(gain).connect(context.destination);
    source.start(context.currentTime + offset);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
    tone(140, offset, 0.12, 0.1);
  };
  return {
    play(cue) {
      if (disposed || !context || context.state !== "running") return;
      switch (cue) {
        case "join":
          tone(659, 0, 0.2);
          tone(988, 0.1, 0.28, 0.06);
          break;
        case "leave":
          tone(784, 0, 0.2);
          tone(523, 0.1, 0.3, 0.06);
          break;
        case "knock":
          thud(0);
          thud(0.17);
          break;
        case "message":
          tone(1175, 0, 0.16, 0.05, "triangle");
          break;
        case "hand-raise":
          tone(1319, 0, 0.32, 0.045);
          tone(1760, 0.07, 0.4, 0.035);
          break;
        case "mute":
          tone(560, 0, 0.07, 0.06, "triangle", 380);
          break;
        case "unmute":
          tone(420, 0, 0.07, 0.06, "triangle", 640);
          break;
        case "recording":
          tone(587, 0, 0.14);
          tone(587, 0.18, 0.14);
          tone(880, 0.36, 0.32, 0.06);
          break;
        case "error":
          tone(392, 0, 0.16, 0.05, "triangle");
          tone(311, 0.13, 0.24, 0.05, "triangle");
          break;
        case "reaction":
          break;
      }
    },
    dispose() {
      disposed = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("click", unlock, true);
        window.removeEventListener("keydown", unlock, true);
      }
      if (context) void context.close();
    },
  };
}
