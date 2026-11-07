// Runs in a proof guest's page. Every time is performance.timeOrigin + performance.now(), so the sender's
// and the receiver's times compare on one host clock.
export function installLatencyProbe() {
  const now = () => performance.timeOrigin + performance.now();
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const snapshot = () => window.proofClient?.getSnapshot();

  // A receiver counts a video frame when it decodes one, and an audio frame when an RTP packet arrives.
  async function inbound() {
    const rows = [];
    for (const [connection, peer] of (window.proofConnections ?? []).entries()) {
      if (peer.connectionState === "closed") continue;
      for (const row of (await peer.getStats()).values()) {
        if (row.type !== "inbound-rtp") continue;
        rows.push({ key: `${connection}:${row.id}`, track: row.trackIdentifier, count: (row.kind === "video" ? row.framesDecoded : row.packetsReceived) ?? 0 });
      }
    }
    return rows;
  }
  const remote = (participantId, source) => (snapshot()?.media.remote ?? []).filter((entry) => entry.participantId === participantId && entry.source === source && entry.track.readyState === "live");
  const member = (participantId) => snapshot()?.participants.roster.find((entry) => entry.participantId === participantId);

  const conditions = {
    // The remote's track for this source moved past the counters it had when the watch was armed.
    async frame({ participantId, source }, baseline) {
      const tracks = new Set(remote(participantId, source).map((entry) => entry.track.id));
      if (!tracks.size) return false;
      return (await inbound()).some((row) => tracks.has(row.track) && row.count > (baseline.get(row.key) ?? 0));
    },
    gone: ({ participantId, source }) => remote(participantId, source).length === 0,
    silent: ({ participantId }) => !(snapshot()?.media.remote ?? []).some((entry) => entry.participantId === participantId && entry.track.readyState === "live"),
    roster: ({ participantId, field, value }) => member(participantId)?.media[field] === value,
    left: ({ participantId }) => snapshot() !== undefined && !member(participantId),
    // The SDK is live with both captures enabled and a peer connection to the media plane is connected.
    ready() {
      const state = snapshot();
      if (state?.connection.status !== "live") return false;
      if (state.media.local.camera.state !== "enabled" || state.media.local.microphone.state !== "enabled") return false;
      return (window.proofConnections ?? []).some((peer) => peer.connectionState === "connected");
    },
  };

  async function poll(spec, baseline, deadline) {
    while (now() < deadline) {
      const at = now();
      if (await conditions[spec.kind](spec, baseline)) return { name: spec.name, at };
      await pause(10);
    }
    return { name: spec.name, at: null };
  }

  const watches = new Map();
  const actions = {
    camera: (enabled) => window.proofClient.media.setCameraEnabled(enabled),
    microphone: (enabled) => window.proofClient.media.setMicrophoneEnabled(enabled),
    screen: (enabled) => window.proofClient.media.setScreenShareEnabled(enabled),
    leave: () => window.proofClient.leave(),
    join: ({ slug, api, name }) => window.proofJoin(slug, api, name),
  };
  window.proofLatency = {
    // arm records the inbound counters, then watches every spec until it holds or the timeout passes.
    async arm(id, specs, timeoutMs) {
      const baseline = new Map((await inbound()).map((row) => [row.key, row.count]));
      const deadline = now() + timeoutMs;
      watches.set(id, Promise.all(specs.map((spec) => poll(spec, baseline, deadline))));
    },
    async result(id) {
      const seen = await watches.get(id);
      watches.delete(id);
      return seen;
    },
    async act(action, value) {
      const at = now();
      await actions[action](value);
      return { at, settledAt: now(), leaveAckAt: window.proofLeave?.ackAt ?? null };
    },
  };
}
