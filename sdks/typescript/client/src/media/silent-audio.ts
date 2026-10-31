export type SilentAudio = {
  readonly track: MediaStreamTrack;
  readonly dispose: () => void;
};

/**
 * A live audio track that carries silence. A muted microphone sender switches to
 * it so the provider keeps seeing RTP and keeps the publication, while the
 * browser releases the real capture. Resolves null where the platform cannot
 * run an audio graph, so the caller falls back to detaching the sender.
 */
export async function createSilentAudio(): Promise<SilentAudio | null> {
  if (typeof AudioContext === "undefined") return null;
  const context = new AudioContext();
  const track = context.createMediaStreamDestination().stream.getAudioTracks()[0];
  // A suspended context renders nothing, so the sender would go quiet at the wire and the provider would expire the track.
  await context.resume().catch(() => undefined);
  if (!track || context.state !== "running") {
    track?.stop();
    await context.close().catch(() => undefined);
    return null;
  }
  return {
    track,
    dispose: () => {
      track.stop();
      void context.close().catch(() => undefined);
    },
  };
}
