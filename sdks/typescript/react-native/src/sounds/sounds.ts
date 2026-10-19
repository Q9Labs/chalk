/// <reference path="./assets.d.ts" />
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import error from "./assets/error.wav";
import hand from "./assets/hand.wav";
import join from "./assets/join.wav";
import knock from "./assets/knock.wav";
import leave from "./assets/leave.wav";
import message from "./assets/message.wav";
import mute from "./assets/mute.wav";
import recording from "./assets/recording.wav";
import test from "./assets/test.wav";
import unmute from "./assets/unmute.wav";

/**
 * The call's sounds, rendered offline from the mockup's WebAudio synth so they sound the same:
 * two rising notes for a join, two falling for a leave, two thuds for a knock, one light tone for
 * a message, two bell notes for a raised hand, a tick for mute and unmute, three notes when
 * recording starts, two low notes for an error, and three rising notes for Test speaker.
 */
const sources = { join, leave, knock, message, hand, mute, unmute, recording, error, test } as const;

export type SoundName = keyof typeof sources;

const players = new Map<SoundName, AudioPlayer>();

/**
 * Plays one sound when `enabled` (the persisted Sounds setting); Test speaker ignores the setting.
 *
 * Players keep the audio session active: expo-audio otherwise deactivates the shared iOS session
 * after each sound, which would cut the call's audio. This module never calls `setAudioModeAsync`,
 * because on Android that resets the audio mode and turns on the speakerphone mid-call. On iOS the
 * silent switch mutes these sounds only outside a call; during a call WebRTC's play-and-record
 * session plays them regardless.
 */
export function playSound(name: SoundName, enabled: boolean): void {
  if (!enabled && name !== "test") return;
  let player = players.get(name);
  if (!player) {
    player = createAudioPlayer(sources[name], { keepAudioSessionActive: true });
    players.set(name, player);
  }
  void player.seekTo(0);
  player.play();
}

/** Frees the players when the call view goes away. */
export function releaseSounds(): void {
  for (const player of players.values()) player.remove();
  players.clear();
}
