import { useCallback, useEffect, useRef } from "react";

import { useMedia, useSpaceClient } from "../bindings/hooks";
import { createSoundPlayer, diffSoundCues, type SoundCue, type SoundPlayer } from "./sound-cues";

/**
 * Plays the join / leave / message / hand-raise / reaction cues for snapshot changes on the
 * current client while `enabled`. Autoplay refusals are retried after the next user gesture.
 */
export function useSoundCues(enabled: boolean, createPlayer: (options: { readonly outputDeviceId?: string }) => SoundPlayer = createSoundPlayer): (cue: SoundCue) => void {
  const playerRef = useRef<SoundPlayer | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const client = useSpaceClient();
  const outputDeviceId = useMedia().selection.speaker ?? undefined;
  const createPlayerRef = useRef(createPlayer);
  createPlayerRef.current = createPlayer;

  useEffect(() => {
    const player = createPlayerRef.current({ outputDeviceId });
    playerRef.current = player;
    let previous = client.getSnapshot();
    const unsubscribe = client.subscribe(() => {
      const next = client.getSnapshot();
      if (enabledRef.current) for (const cue of diffSoundCues(previous, next)) player.play(cue);
      previous = next;
    });
    const offError = client.on("error", () => {
      if (enabledRef.current) player.play("error");
    });
    return () => {
      unsubscribe();
      offError();
      player.dispose();
      playerRef.current = null;
    };
  }, [client, outputDeviceId]);
  return useCallback((cue: SoundCue) => {
    if (enabledRef.current) playerRef.current?.play(cue);
  }, []);
}
