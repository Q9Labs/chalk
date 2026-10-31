export class SilentAudioSource {
  #context: AudioContext | null = null;
  #track: MediaStreamTrack | null = null;

  track(): MediaStreamTrack | null {
    const liveTrack = this.#liveTrack();
    if (liveTrack) return liveTrack;
    const context = this.#getContext();
    if (!context) return null;
    try {
      this.#createTrack(context);
      this.#resume(context);
      return context.state === "running" ? this.#track : null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.#track?.stop();
    this.#track = null;
    if (this.#context) void this.#context.close().catch(() => undefined);
    this.#context = null;
  }

  #liveTrack(): MediaStreamTrack | null {
    if (!this.#context || !this.#track || this.#track.readyState !== "live") return null;
    this.#resume(this.#context);
    return this.#context.state === "running" ? this.#track : null;
  }

  #getContext(): AudioContext | null {
    if (this.#context) return this.#context;
    const AudioContextConstructor = globalThis.AudioContext;
    if (!AudioContextConstructor) return null;
    try {
      this.#context = new AudioContextConstructor();
      return this.#context;
    } catch {
      return null;
    }
  }

  #createTrack(context: AudioContext): void {
    if (this.#track?.readyState === "live") return;
    const source = context.createConstantSource();
    const destination = context.createMediaStreamDestination();
    source.offset.value = 0;
    source.connect(destination);
    source.start();
    this.#track = destination.stream.getAudioTracks()[0] ?? null;
  }

  #resume(context: AudioContext): void {
    if (context.state !== "running") void context.resume().catch(() => undefined);
  }
}
