/** A browser-shaped media track used when canvas or Web Audio is unavailable. */
export class PreviewSyntheticMediaTrack extends EventTarget implements MediaStreamTrack {
  readonly contentHint = "";
  enabled = true;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  muted = false;
  onended: ((this: MediaStreamTrack, event: Event) => unknown) | null = null;
  onmute: ((this: MediaStreamTrack, event: Event) => unknown) | null = null;
  onunmute: ((this: MediaStreamTrack, event: Event) => unknown) | null = null;
  readyState: MediaStreamTrackState = "live";

  constructor(kind: "audio" | "video", id: string, label = "Chalk SDK preview") {
    super();
    this.kind = kind;
    this.id = id;
    this.label = label;
  }

  applyConstraints(): Promise<void> {
    return Promise.resolve();
  }

  clone(): MediaStreamTrack {
    return new PreviewSyntheticMediaTrack(this.kind === "audio" ? "audio" : "video", `${this.id}-clone`, this.label);
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
    if (this.readyState === "ended") return;
    this.readyState = "ended";
  }
}

export function createPreviewSyntheticTrack(kind: "audio" | "video", id: string, label?: string): MediaStreamTrack {
  return new PreviewSyntheticMediaTrack(kind, id, label);
}
