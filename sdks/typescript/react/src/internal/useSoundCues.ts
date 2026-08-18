import { useEffect, useRef } from "react";

import { useSpaceClient } from "../bindings/hooks";
import { createSoundPlayer, diffSoundCues, type SoundPlayer } from "./sound-cues";

/**
 * Plays the join / leave / message / hand-raise / reaction cues for snapshot changes on the
 * current client while `enabled`. Autoplay refusals before the first user gesture are ignored.
 */
export function useSoundCues(enabled: boolean, createPlayer: () => SoundPlayer = () => createSoundPlayer()): void {
  const client = useSpaceClient();
  const createPlayerRef = useRef(createPlayer);
  createPlayerRef.current = createPlayer;

  useEffect(() => {
    if (!enabled) return;
    const player = createPlayerRef.current();
    let previous = client.getSnapshot();
    const unsubscribe = client.subscribe(() => {
      const next = client.getSnapshot();
      for (const cue of diffSoundCues(previous, next)) player.play(cue);
      previous = next;
    });
    return () => {
      unsubscribe();
      player.dispose();
    };
  }, [client, enabled]);
}
