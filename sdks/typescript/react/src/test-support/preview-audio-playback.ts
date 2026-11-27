type PlaybackEntry = { blocked: boolean; readonly element?: HTMLAudioElement; readonly context?: AudioContext };

/** Preview playback evidence follows the same observable rules as the client: only real NotAllowedError evidence or a suspended context blocks. */
export function createPreviewAudioPlayback(changed: (blocked: boolean) => void) {
  const entries = new Set<PlaybackEntry>();
  const sync = (): void => changed([...entries].some((entry) => entry.blocked));
  return {
    observeAudioElement: (_track: MediaStreamTrack, element: HTMLAudioElement) => {
      const entry: PlaybackEntry = { blocked: false, element };
      entries.add(entry);
      return {
        played: (result: unknown) => {
          if (!entries.has(entry)) return;
          if (result === undefined) entry.blocked = false;
          else if (typeof result === "object" && result !== null && "name" in result && result.name === "NotAllowedError" && element.paused) entry.blocked = true;
          else return;
          sync();
        },
        detach: () => {
          if (!entries.delete(entry)) return;
          sync();
        },
      };
    },
    observeAudioContext: (context: AudioContext) => {
      const entry: PlaybackEntry = { blocked: context.state === "suspended", context };
      entries.add(entry);
      const update = () => {
        entry.blocked = context.state === "suspended";
        sync();
      };
      context.addEventListener("statechange", update);
      sync();
      return {
        detach: () => {
          context.removeEventListener("statechange", update);
          if (!entries.delete(entry)) return;
          sync();
        },
      };
    },
    resumeAudioPlayback: async () => {
      await Promise.allSettled(
        [...entries].map(async (entry) => {
          if (!entry.blocked) return;
          try {
            if (entry.element) await entry.element.play();
            else if (entry.context?.state === "suspended") await entry.context.resume();
            entry.blocked = false;
          } catch {
            entry.blocked = true;
          }
        }),
      );
      sync();
    },
    dispose: () => entries.clear(),
  };
}
