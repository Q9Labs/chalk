// What the join-call check needs to say WHY a tile stayed empty: the state of the tile and its track, a measured wait,
// and a per-page dump of WebRTC stats, console errors and failed requests. The check stays strict; this only explains it.

// Runs in the page. Describes one participant's tile as shown in this page: how many frames were decoded and whether a
// track ever arrived. The three "0 frames" causes (no video element, nothing loaded, no picture yet) stay apart.
// fallow-ignore-next-line complexity
export const tileState = (name) => {
  const tile = document.querySelector(`[aria-label="Video tile for ${name}"]`)?.closest('[data-part="stage-tile"]');
  const video = tile?.querySelector("video");
  const track = video?.srcObject?.getVideoTracks?.()[0];
  const decoding = Boolean(video) && video.readyState >= 2 && video.videoWidth > 0;
  return {
    tile: Boolean(tile),
    video: Boolean(video),
    frames: decoding ? video.getVideoPlaybackQuality().totalVideoFrames : 0,
    readyState: video?.readyState ?? null,
    width: video?.videoWidth ?? null,
    track: track ? { readyState: track.readyState, muted: track.muted } : null,
  };
};

// Runs in the page. Summarises every RTCPeerConnection the proof fixture saw; no addresses, only types and counters.
export const peerStats = async () => {
  const pick = (row, keys) => Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
  const connections = window.proofConnections ?? [];
  return Promise.all(
    // fallow-ignore-next-line complexity
    connections.map(async (connection) => {
      const rows = [...(await connection.getStats()).values()];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const transport = rows.find((row) => row.type === "transport");
      const pair = byId.get(transport?.selectedCandidatePairId);
      const video = (type) => rows.filter((row) => row.type === type && (row.kind ?? row.mediaType) === "video");
      return {
        connectionState: connection.connectionState,
        iceConnectionState: connection.iceConnectionState,
        signalingState: connection.signalingState,
        transport: transport ? pick(transport, ["dtlsState", "iceState", "bytesSent", "bytesReceived"]) : null,
        selectedPair: pair
          ? {
              ...pick(pair, ["state", "currentRoundTripTime"]),
              localType: byId.get(pair.localCandidateId)?.candidateType,
              remoteType: byId.get(pair.remoteCandidateId)?.candidateType,
            }
          : null,
        inboundVideo: video("inbound-rtp").map((row) => pick(row, ["packetsReceived", "bytesReceived", "packetsLost", "framesReceived", "framesDecoded", "framesDropped", "framesPerSecond", "frameWidth", "frameHeight", "keyFramesDecoded", "pliCount", "firCount", "nackCount", "freezeCount"])),
        outboundVideo: video("outbound-rtp").map((row) => pick(row, ["rid", "packetsSent", "bytesSent", "framesEncoded", "keyFramesEncoded", "frameWidth", "frameHeight", "framesPerSecond", "targetBitrate", "qualityLimitationReason", "pliCount", "firCount", "nackCount", "active"])),
      };
    }),
  );
};

// Polls one tile until it decodes a frame or the time runs out. firstFrameMs is null when it never did.
export async function measureFirstFrame(page, name, { timeoutMs, pollMs = 500 }) {
  const started = Date.now();
  let state = await page.evaluate(tileState, name);
  while (state.frames === 0 && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    state = await page.evaluate(tileState, name);
  }
  return { firstFrameMs: state.frames > 0 ? Date.now() - started : null, state };
}

// fallow-ignore-next-line complexity
export function describeState(state) {
  if (!state.tile) return "no tile on the page";
  if (!state.video) return "tile has no video element";
  const track = state.track ? `track ${state.track.readyState}${state.track.muted ? ", muted" : ""}` : "no video track attached";
  return `readyState ${state.readyState}, width ${state.width}, ${track}`;
}

// A sender whose own tile shows no picture never published, so the receiver cannot be blamed.
export function senderNeverPublished(name, measured, timeoutMs) {
  return `sender never published: ${name}'s own tile decoded 0 frames in ${timeoutMs / 1000} s (${describeState(measured.state)})`;
}

export function receiverTimedOut(name, other, measured, timeoutMs) {
  return `${timeoutMs / 1000} s timeout: ${other}'s tile on ${name}'s page decoded 0 frames (${describeState(measured.state)})`;
}

const failedRequest = (entry) => entry.status >= 400 || entry.error !== undefined;

// Everything the artifact needs about one page, gathered while the page is still open.
export async function collectPage(session, { tileNames, logs, measurements }) {
  const { name, page } = session;
  const attempt = async (read) => {
    try {
      return await read();
    } catch (error) {
      return { unavailable: String(error.message ?? error).slice(0, 200) };
    }
  };
  return {
    who: name,
    firstFrameMs: measurements[name] ?? {},
    tiles: await attempt(async () => Object.fromEntries(await Promise.all(tileNames.map(async (tile) => [tile, await page.evaluate(tileState, tile)])))),
    peers: await attempt(() => page.evaluate(peerStats)),
    consoleErrors: logs.console.filter((entry) => entry.who === name && (entry.type === "error" || entry.type === "pageerror")),
    failedRequests: logs.network.filter((entry) => entry.who === name && failedRequest(entry)),
  };
}
