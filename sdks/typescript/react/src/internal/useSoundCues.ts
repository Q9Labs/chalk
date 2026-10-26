import type { ClientFailure } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useRef } from "react";

import { useMedia, useSpaceClient } from "../bindings/hooks";
import { createSoundPlayer, diffSoundCues, type SoundCue, type SoundPlayer } from "./sound-cues";

/**
 * Plays the join / leave / message / hand-raise / reaction cues for snapshot changes on the
 * current client while `enabled`. Autoplay refusals are retried after the next user gesture.
 */
export function useSoundCues(enabled: boolean, createPlayer: (options: { readonly outputDeviceId?: string }) => SoundPlayer = createSoundPlayer): (cue: SoundCue, failure?: ClientFailure) => void {
  const playerRef = useRef<SoundPlayer | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const client = useSpaceClient();
  const outputDeviceId = useMedia().selection.speaker ?? undefined;
  const createPlayerRef = useRef(createPlayer);
  createPlayerRef.current = createPlayer;

  const pendingFailures = useRef(new Set<string>());
  const failureTurn = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const playFailure = useCallback((failure: ClientFailure) => {
    const key = JSON.stringify([failure.code, failure.message, failure.recoverable]);
    if (!enabledRef.current || pendingFailures.current.has(key)) return;
    pendingFailures.current.add(key);
    playerRef.current?.play("error");
    if (failureTurn.current === undefined)
      failureTurn.current = setTimeout(() => {
        pendingFailures.current.clear();
        failureTurn.current = undefined;
      }, 0);
  }, []);

  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing sound event subscriptions and audio cleanup.
  useEffect(() => {
    const player = createPlayerRef.current({ outputDeviceId });
    playerRef.current = player;
    let previous = client.getSnapshot();
    const unsubscribe = client.subscribe(() => {
      const next = client.getSnapshot();
      if (enabledRef.current) for (const cue of diffSoundCues(previous, next)) player.play(cue);
      previous = next;
    });
    const offError = client.on("error", ({ error }) => playFailure(error));
    return () => {
      unsubscribe();
      offError();
      player.dispose();
      playerRef.current = null;
      clearTimeout(failureTurn.current);
      failureTurn.current = undefined;
      pendingFailures.current.clear();
    };
  }, [client, outputDeviceId, playFailure]);
  return useCallback(
    (cue: SoundCue, failure?: ClientFailure) => {
      if (cue === "error" && failure) return playFailure(failure);
      if (enabledRef.current) playerRef.current?.play(cue);
    },
    [playFailure],
  );
}
