import { useEffect, useRef } from "react";

import { useMedia, useSpaceClient } from "../bindings/hooks";
import { createSoundPlayer, diffSoundCues, type SoundPlayer } from "./sound-cues";

/**
 * Plays the join / leave / message / hand-raise / reaction cues for snapshot changes on the
 * current client while `enabled`. Autoplay refusals are retried after the next user gesture.
 */
export function useSoundCues(enabled: boolean, createPlayer: (options: { readonly outputDeviceId?: string }) => SoundPlayer = createSoundPlayer): void {
  const client = useSpaceClient();
  const outputDeviceId = useMedia().selection.speaker ?? undefined;
  const createPlayerRef = useRef(createPlayer);
  createPlayerRef.current = createPlayer;

  useEffect(() => {
    if (!enabled) return;
    const player = createPlayerRef.current({ outputDeviceId });
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
  }, [client, enabled, outputDeviceId]);
}
