// fallow-ignore-file unused-file -- throwaway spike entrypoints are run directly, not through the workspace graph.
// fallow-ignore-file complexity -- throwaway measurement harness; the spike report records results rather than productionizing branching.
import { loadAdapter } from "./webrtc-adapters.mjs";

const clientDist = new URL("../../sdks/typescript/client/dist/", import.meta.url);
const { SFUClient, createSFUHTTPTransport, createV1SyncClient, createReactNativeWebSocketFactory, mediaBootstrap } = await import(new URL("index.js", clientDist));
const { createSpaceClientForPlatform } = await import(new URL("effect.js", clientDist));

export class PcmToneWriter {
  constructor(microphone, { sampleRate = 48000, channelCount = 1 } = {}) {
    this.microphone = microphone;
    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
    this.frames = 0;
    this.tone = null;
    this.phase = 0;
    this.timer = null;
    this.nextAt = 0;
  }
  start() {
    if (this.timer) return;
    this.nextAt = Date.now();
    const tick = () => {
      this.nextAt += 10;
      this.writeFrame();
      this.timer = setTimeout(tick, Math.max(1, this.nextAt - Date.now()));
    };
    this.timer = setTimeout(tick, 0);
  }
  scheduleTone({ startAt, durationMs = 600, frequency = 880, amplitude = 0.35 }) {
    this.tone = { startAt, endAt: startAt + durationMs, frequency, amplitude };
    return { startAt, durationMs, frequency };
  }
  writeFrame() {
    const count = (this.sampleRate / 100) | 0;
    const samples = new Int16Array(count * this.channelCount);
    const now = Date.now();
    const tone = this.tone && now >= this.tone.startAt && now < this.tone.endAt ? this.tone : null;
    if (tone) {
      const step = (2 * Math.PI * tone.frequency) / this.sampleRate;
      for (let i = 0; i < count; i++) {
        const value = Math.sin(this.phase + step * i) * tone.amplitude * 32767;
        for (let channel = 0; channel < this.channelCount; channel++) samples[i * this.channelCount + channel] = value;
      }
      this.phase += step * count;
    }
    this.microphone.writePcm({ samples, sampleRate: this.sampleRate, channelCount: this.channelCount });
    this.frames++;
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export class PcmTrackProbe {
  constructor(publication) {
    this.publication = { participantId: publication.participantId, source: publication.source, publicationId: publication.publicationId };
    this.frames = 0;
    this.firstFrameAt = null;
    this.lastFrameAt = null;
    this.sampleRate = null;
    this.channelCount = null;
    this.energy = 0;
    this.peak = 0;
    this.onsets = [];
  }
  frame(frame, at = Date.now()) {
    this.frames++;
    this.firstFrameAt ??= at;
    this.lastFrameAt = at;
    this.sampleRate = frame.sampleRate;
    this.channelCount = frame.channelCount;
    let sum = 0;
    let peak = 0;
    for (const sample of frame.samples) {
      const magnitude = Math.abs(sample);
      sum += sample * sample;
      if (magnitude > peak) peak = magnitude;
    }
    const rms = Math.sqrt(sum / Math.max(1, frame.samples.length));
    this.energy += (sum / Math.max(1, frame.samples.length)) / 32768 ** 2;
    this.peak = Math.max(this.peak, peak);
    if (rms > 500) {
      const last = this.onsets.at(-1);
      if (!last || at - last.at > 300) this.onsets.push({ at, rms: Math.round(rms) });
    }
  }
  snapshot() {
    return { ...this.publication, frames: this.frames, firstFrameAt: this.firstFrameAt, lastFrameAt: this.lastFrameAt, sampleRate: this.sampleRate, channelCount: this.channelCount, meanSquareEnergy: this.energy, peak: this.peak, onsets: this.onsets.slice(-20) };
  }
}

function bindMediaClient(client, restart) {
  return {
    prepareLocalPublicationTarget: client.prepareLocalPublicationTarget.bind(client),
    cancelPreparedLocalPublicationTarget: client.cancelPreparedLocalPublicationTarget.bind(client),
    setLocalPublicationTarget: client.setLocalPublicationTarget.bind(client),
    pauseLocalCapture: client.pauseLocalCapture.bind(client),
    setLocalSourceIntent: client.setLocalSourceIntent.bind(client),
    closeForcedLocalPublication: client.closeForcedLocalPublication.bind(client),
    observeLocalPublications: client.observeLocalPublications.bind(client),
    observeRemotePublications: client.observeRemotePublications.bind(client),
    remotePublicationsChanged: client.remotePublicationsChanged.bind(client),
    remoteParticipantsChanged: client.remoteParticipantsChanged.bind(client),
    remotePublicationResumed: client.remotePublicationResumed.bind(client),
    localPublicationWithdrawn: client.localPublicationWithdrawn.bind(client),
    start: client.start.bind(client),
    stop: client.stop.bind(client),
    restart,
    prepareLocalTrack: client.prepareLocalTrack.bind(client),
    clearPreparedLocalTrack: client.clearPreparedLocalTrack.bind(client),
    getSnapshot: client.getSnapshot.bind(client),
    subscribe: client.subscribe.bind(client),
  };
}

export async function createNodeAgent({ library, server, spaceId, episodeId, participant, initialAccess, apiBaseUrl, syncUrl, onEvent = () => {} }) {
  const adapter = await loadAdapter(library);
  const microphone = adapter.createMicrophone();
  const tone = new PcmToneWriter(microphone);
  const stream = new adapter.MediaStream([microphone.track]);
  const probes = new Map();
  const sinks = [];
  let refreshState = refreshStateFor(initialAccess);
  let currentAccess = initialAccess;
  const diagnostics = [];
  const mediaSnapshots = [];

  const getAccess = async (context) => {
    if (context.reason === "join" && currentAccess) return currentAccess;
    const grant = await server.participants.issueAccess(
      spaceId,
      episodeId,
      participant.id,
      { participantGeneration: refreshState.participantGeneration, currentMediaToken: refreshState.currentMediaToken },
      { replaceMediaConnection: context.replaceMediaConnection === true, ...(context.expectedMediaConnectionId ? { expectedMediaConnectionId: context.expectedMediaConnectionId } : {}), ...(context.currentMediaToken ? { currentMediaToken: context.currentMediaToken } : {}) },
    );
    currentAccess = grant;
    refreshState = refreshStateFor(grant);
    onEvent({ type: "access-issued", at: Date.now(), refresh: context.reason, replaceMediaConnection: context.replaceMediaConnection === true });
    return grant;
  };

  const createMediaClient = (input) => {
    const bootstrap = mediaBootstrap(input.access.media);
    const client = new SFUClient({
      bootstrap,
      participantId: input.access.subject.participantId,
      transport: createSFUHTTPTransport({
        apiBaseURL: apiBaseUrl,
        credential: input.credential,
        refreshCredential: input.refreshCredential,
        tenantId: input.access.subject.tenantId,
        spaceId: input.access.subject.spaceId,
        episodeId: input.access.subject.episodeId,
        participantId: input.access.subject.participantId,
      }),
      replaceMediaConnection: input.replaceMediaConnection ? async (observedConnectionId) => mediaBootstrap(await input.replaceMediaConnection(observedConnectionId)) : undefined,
      peerConnectionFactory: adapter.peerConnectionFactory,
      onError: (error, connectionId) => { onEvent({ type: "media-error", error: String(error?.stack ?? error?.message ?? error).slice(0, 1000), connectionId }); input.onFailure?.(error, connectionId); },
      onScreenEnded: input.onScreenEnded,
      onRemoteTrack: (publication) => {
        if (publication.track.kind !== "audio" || probes.has(publication.publicationId)) return;
        const probe = new PcmTrackProbe(publication);
        probes.set(publication.publicationId, probe);
        const detach = adapter.attachAudioSink(publication.track, (frame) => probe.frame(frame));
        sinks.push(detach);
        onEvent({ type: "remote-track", at: Date.now(), ...probe.publication });
      },
    });
    client.subscribe(() => {
      const snapshot = client.getSnapshot();
      mediaSnapshots.push({ at: Date.now(), phase: snapshot.connection.phase, peerConnectionState: snapshot.connection.peerConnectionState, iceConnectionState: snapshot.connection.iceConnectionState, local: snapshot.localTracks.length, remote: snapshot.remoteTracks.length, failure: snapshot.failure?.code ?? null });
    });
    return bindMediaClient(client, (next) => client.restart("provider" in next ? mediaBootstrap(next) : next));
  };

  const lifecycle = { subscribe: (listener) => (listener("active"), listener("online"), () => {}) };
  const webSocket = createReactNativeWebSocketFactory();
  const createSyncClient = (input) =>
    createV1SyncClient({
      url: syncUrl,
      token: input.token,
      mediaPlane: input.media,
      lifecycle,
      webSocket,
      entryConfirmation: true,
      collaboration: { name: "collaboration_v2", chatCursor: { afterSequence: null, retainedFloorSequence: null } },
    });

  const client = createSpaceClientForPlatform(
    { space: spaceId, baseUrl: apiBaseUrl, getAccess },
    {
      apiBaseUrl,
      syncUrl,
      whiteboardUrl: null,
      initialMicrophoneEnabled: true,
      initialCameraEnabled: false,
      onConnectionDiagnostic: (event) => {
        diagnostics.push({ at: Date.now(), ...event });
        if (event.event?.startsWith("access_")) onEvent({ type: event.event, at: Date.now(), state: event.state });
      },
      dependencies: {
        telemetry: undefined,
        clock: { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle) },
        mediaDevices: {
          getUserMedia: async () => stream,
          getDisplayMedia: async () => {
            throw new Error("screen capture is outside the Node spike");
          },
          enumerateDevices: async () => [],
          releaseTrack: (track) => track.stop(),
        },
        createMediaClient,
        createSyncClient,
        createWhiteboardClient: () => null,
        subscribeForeground: () => () => {},
        createId: () => crypto.randomUUID(),
      },
    },
  );

  tone.start();
  return {
    client,
    adapter,
    tone,
    probes,
    diagnostics,
    mediaSnapshots,
    async join(displayName) {
      const at = Date.now();
      await client.join({ displayName, microphone: true, camera: false });
      return { startedAt: at, joinedAt: Date.now(), joinMs: Date.now() - at };
    },
    async close() {
      tone.stop();
      for (const detach of sinks.splice(0)) detach();
      await client.close().catch(() => client.dispose());
      microphone.stop();
    },
  };
}

function refreshStateFor(access) {
  return { participantGeneration: access.subject.participant_generation, currentMediaToken: access.media.token };
}
