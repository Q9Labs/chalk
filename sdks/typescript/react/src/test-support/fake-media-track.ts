/** Minimal MediaStreamTrack stand-in for DOM tests: real event dispatch, no media. */
class FakeMediaStreamTrack extends EventTarget implements MediaStreamTrack {
  contentHint = "";
  enabled = true;
  readonly id: string;
  readonly kind: string;
  readonly label = "fake";
  muted: boolean;
  onended: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;
  onmute: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;
  onunmute: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;
  readyState: MediaStreamTrackState;

  constructor(kind: "video" | "audio", id: string, muted: boolean, readyState: MediaStreamTrackState) {
    super();
    this.kind = kind;
    this.id = id;
    this.muted = muted;
    this.readyState = readyState;
  }

  applyConstraints(): Promise<void> {
    return Promise.resolve();
  }
  clone(): MediaStreamTrack {
    return new FakeMediaStreamTrack(this.kind === "audio" ? "audio" : "video", `${this.id}-clone`, this.muted, this.readyState);
  }
  getCapabilities(): MediaTrackCapabilities {
    return {};
  }
  getConstraints(): MediaTrackConstraints {
    return {};
  }
  getSettings(): MediaTrackSettings {
    return {};
  }
  stop(): void {
    this.readyState = "ended";
  }
  /** Simulates the browser signalling that frames stopped or resumed. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.dispatchEvent(new Event(muted ? "mute" : "unmute"));
  }
  /** Simulates the source ending. */
  end(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

export interface FakeMediaStreamTrackOptions {
  readonly kind?: "video" | "audio";
  readonly id?: string;
  readonly muted?: boolean;
  readonly readyState?: MediaStreamTrackState;
}

export function createFakeMediaStreamTrack({ kind = "video", id = `${kind}-track`, muted = false, readyState = "live" }: FakeMediaStreamTrackOptions = {}): FakeMediaStreamTrack {
  return new FakeMediaStreamTrack(kind, id, muted, readyState);
}

export type { FakeMediaStreamTrack };
