// Browser-side sample of what one guest receives, per sending participant and source. Passed to page.evaluate.
// A row's key names its connection and track, so a counter only compares with itself: a replaced connection starts at zero.
export function sampleRemote() {
  const snapshot = window.proofClient.getSnapshot();
  const remote = snapshot.media.remote;
  return (async () => {
    const rows = [];
    for (let connection = 0; connection < window.proofConnections.length; connection++) {
      for (const row of (await window.proofConnections[connection].getStats()).values()) {
        if (row.type !== "inbound-rtp") continue;
        const entry = remote.find((candidate) => candidate.track.id === row.trackIdentifier);
        if (!entry) continue;
        rows.push({
          key: `${connection}:${row.trackIdentifier}`,
          participantId: entry.participantId,
          source: entry.source,
          kind: row.kind,
          bytes: row.bytesReceived ?? 0,
          frames: row.framesDecoded ?? 0,
          energy: row.totalAudioEnergy ?? 0,
        });
      }
    }
    return {
      at: performance.now(),
      self: snapshot.self.participantId,
      status: snapshot.connection.status,
      roster: snapshot.participants.roster.map((participant) => participant.participantId),
      remote: remote.map((entry) => ({ participantId: entry.participantId, source: entry.source })),
      microphone: snapshot.media.local.microphone.state,
      camera: snapshot.media.local.camera.state,
      rows,
    };
  })();
}

export const sample = (page) => page.evaluate(sampleRemote);
