/** Canvas tracks must retain the camera's mute and enabled semantics, including private previews. */
export function bindCameraEffectLifecycle(source: MediaStreamTrack, output: MediaStreamTrack): () => void {
  const tracks = new Set<MediaStreamTrack>();
  const clones = new Map<MediaStreamTrack, () => void>();
  const prototype = typeof MediaStreamTrack === "undefined" ? undefined : MediaStreamTrack.prototype;
  const enabled = prototype ? Object.getOwnPropertyDescriptor(prototype, "enabled") : undefined;
  const muted = prototype ? Object.getOwnPropertyDescriptor(prototype, "muted") : undefined;
  const sync = () => {
    let enabled = false;
    for (const track of tracks)
      if (track.enabled) {
        enabled = true;
        break;
      }
    source.enabled = enabled;
  };
  const decorate = (track: MediaStreamTrack) => {
    tracks.add(track);
    let fallback = track.enabled;
    const read = enabled?.get?.bind(track) ?? (() => fallback);
    const write =
      enabled?.set?.bind(track) ??
      ((value: boolean) => {
        fallback = value;
      });
    const initialMuted = track.muted;
    const readMuted = muted?.get?.bind(track) ?? (() => initialMuted);
    Object.defineProperty(track, "enabled", {
      configurable: true,
      get: read,
      set: (value: boolean) => {
        write(value);
        sync();
      },
    });
    Object.defineProperty(track, "muted", { configurable: true, get: () => source.muted || readMuted() });
    const clone = track.clone.bind(track);
    track.clone = () => {
      const copy = clone();
      copy.getSettings = output.getSettings;
      decorate(copy);
      const stop = copy.stop.bind(copy);
      clones.set(copy, stop);
      copy.stop = () => {
        stop();
        clones.delete(copy);
        tracks.delete(copy);
        sync();
      };
      sync();
      return copy;
    };
  };
  output.enabled = source.enabled;
  decorate(output);
  const forward = (event: Event) => {
    for (const track of tracks) track.dispatchEvent(new Event(event.type));
  };
  source.addEventListener("mute", forward);
  source.addEventListener("unmute", forward);
  return () => {
    source.removeEventListener("mute", forward);
    source.removeEventListener("unmute", forward);
    for (const stop of clones.values()) stop();
    clones.clear();
    tracks.clear();
  };
}
