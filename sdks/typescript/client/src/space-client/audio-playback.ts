export type AudioPlaybackSlice = {
  readonly blocked: boolean;
};

export type AudioElementObservation = {
  readonly played: (result: unknown) => void;
  readonly detach: () => void;
};

export type AudioContextObservation = {
  readonly detach: () => void;
};

type ElementEntry = {
  blocked: boolean;
  readonly health: AudioElementObservation;
  readonly onPlaying: () => void;
};

type ContextEntry = {
  blocked: boolean;
  readonly context: AudioContext;
  readonly onStateChange: () => void;
};

type AudioPlaybackOptions = {
  readonly observeElement: (track: MediaStreamTrack, element: HTMLAudioElement) => AudioElementObservation;
  readonly changed: () => void;
};

const UNBLOCKED: AudioPlaybackSlice = Object.freeze({ blocked: false });

/**
 * Browser output state for elements and contexts owned by the embedding UI.
 * A block is evidence-backed: a real NotAllowedError play() rejection, or a
 * registered AudioContext reporting suspended. Success or detach clears it.
 */
export class AudioPlayback {
  readonly #options: AudioPlaybackOptions;
  readonly #elements = new Map<HTMLAudioElement, ElementEntry>();
  readonly #contexts = new Set<ContextEntry>();
  #snapshot: AudioPlaybackSlice = UNBLOCKED;
  #resuming: Promise<void> | undefined;

  constructor(options: AudioPlaybackOptions) {
    this.#options = options;
  }

  get snapshot(): AudioPlaybackSlice {
    return this.#snapshot;
  }

  observeElement(track: MediaStreamTrack, element: HTMLAudioElement): AudioElementObservation {
    const previous = this.#elements.get(element);
    previous?.health.detach();
    if (previous) element.removeEventListener("playing", previous.onPlaying);
    const health = this.#options.observeElement(track, element);
    const entry: ElementEntry = {
      blocked: previous?.blocked ?? false,
      health,
      onPlaying: () => {
        if (this.#elements.get(element) !== entry) return;
        entry.blocked = false;
        this.#publish();
      },
    };
    element.addEventListener("playing", entry.onPlaying);
    this.#elements.set(element, entry);
    return {
      played: (result) => {
        health.played(result);
        this.#recordElementResult(element, entry, result);
      },
      detach: () => {
        if (this.#elements.get(element) !== entry) return;
        this.#elements.delete(element);
        element.removeEventListener("playing", entry.onPlaying);
        health.detach();
        this.#publish();
      },
    };
  }

  observeAudioContext(context: AudioContext): AudioContextObservation {
    const entry: ContextEntry = {
      blocked: false,
      context,
      onStateChange: () => {
        entry.blocked = context.state === "suspended";
        this.#publish();
      },
    };
    context.addEventListener("statechange", entry.onStateChange);
    this.#contexts.add(entry);
    entry.onStateChange();
    return {
      detach: () => {
        if (!this.#contexts.delete(entry)) return;
        context.removeEventListener("statechange", entry.onStateChange);
        this.#publish();
      },
    };
  }

  async resume(): Promise<void> {
    this.#resuming ??= this.#resumeNow().finally(() => {
      this.#resuming = undefined;
    });
    return this.#resuming;
  }

  dispose(): void {
    for (const [element, entry] of this.#elements) {
      element.removeEventListener("playing", entry.onPlaying);
      entry.health.detach();
    }
    for (const entry of this.#contexts) entry.context.removeEventListener("statechange", entry.onStateChange);
    this.#elements.clear();
    this.#contexts.clear();
    this.#publish();
  }

  async #resumeNow(): Promise<void> {
    const elements = [...this.#elements].filter(([, entry]) => entry.blocked);
    const contexts = [...new Set([...this.#contexts].filter((entry) => entry.blocked).map((entry) => entry.context))];
    await Promise.allSettled([
      ...elements.map(async ([element, entry]) => {
        try {
          await element.play();
          this.#reportElementResult(element, entry, undefined);
        } catch (cause) {
          this.#reportElementResult(element, entry, cause);
        }
      }),
      ...contexts.map(async (context) => {
        try {
          if (context.state === "suspended") await context.resume();
        } catch {
          // The state read below is the evidence; a rejected resume simply leaves it suspended.
        }
        for (const entry of this.#contexts) if (entry.context === context) entry.onStateChange();
      }),
    ]);
  }

  #reportElementResult(element: HTMLAudioElement, entry: ElementEntry, result: unknown): void {
    if (this.#elements.get(element) !== entry) return;
    entry.health.played(result);
    this.#recordElementResult(element, entry, result);
  }

  #recordElementResult(element: HTMLAudioElement, entry: ElementEntry, result: unknown): void {
    if (this.#elements.get(element) !== entry) return;
    if (result === undefined) entry.blocked = false;
    else if (autoplayRefusal(result) && element.paused) entry.blocked = true;
    else return;
    this.#publish();
  }

  #publish(): void {
    const blocked = [...this.#elements.values()].some((entry) => entry.blocked) || [...this.#contexts].some((entry) => entry.blocked);
    if (blocked === this.#snapshot.blocked) return;
    this.#snapshot = Object.freeze({ blocked });
    this.#options.changed();
  }
}

function autoplayRefusal(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "name" in cause && cause.name === "NotAllowedError";
}
