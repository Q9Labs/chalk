export function track(kind: "audio" | "video"): MediaStreamTrack {
  let readyState: MediaStreamTrackState = "live";
  const result = Object.assign(new EventTarget(), {
    contentHint: "",
    enabled: true,
    id: kind,
    kind,
    label: "",
    muted: false,
    get readyState() {
      return readyState;
    },
    onended: null,
    onmute: null,
    onunmute: null,
    applyConstraints: async () => undefined,
    clone: () => track(kind),
    getCapabilities: () => ({}),
    getConstraints: () => ({}),
    getSettings: () => ({}),
    stop: () => {
      readyState = "ended";
    },
  });
  Object.defineProperty(result, "readyState", { get: () => readyState });
  return result;
}

export function stream(tracks: readonly MediaStreamTrack[]): MediaStream {
  return Object.assign(new EventTarget(), {
    active: true,
    id: "capture",
    onaddtrack: null,
    onremovetrack: null,
    addTrack: () => undefined,
    removeTrack: () => undefined,
    clone: () => stream(tracks),
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter((input) => input.kind === "audio"),
    getVideoTracks: () => tracks.filter((input) => input.kind === "video"),
    getTrackById: (id: string) => tracks.find((input) => input.id === id) ?? null,
  });
}
