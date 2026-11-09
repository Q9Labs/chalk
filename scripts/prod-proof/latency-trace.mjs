// Runs in a proof guest's page as an init script, installed after the fixture and only by the latency kit. It records
// timed wire events (Sync frames, SFU signaling replies, the first connected peer connection) without changing what
// the SDK sends or receives, the way installLeaveObservation does. The product SDK carries no trace code.
//
// Every time is performance.timeOrigin + performance.now(). Both guests run on one host, so those readings share the
// host's clock and compare across pages to within the browser's clock resolution (about 0.1 ms).
export function installLatencyTrace() {
  const now = () => performance.timeOrigin + performance.now();
  const MAX_EVENTS = 4000;
  const events = [];
  const log = (k, d) => {
    if (events.length < MAX_EVENTS) events.push({ t: now(), k, d });
  };
  const parse = (data) => {
    try {
      return typeof data === "string" ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  };

  // Sync frames. The trace only watches them: it never sends on a socket, so nothing it does can reach the SDK's liveness checks.
  const sentName = (frame) => {
    if (frame?.type === "live_target") return `live_target:${frame.name}:${frame.enabled}`;
    return ["ping", "hello", "entered"].includes(frame?.type) ? frame.type : null;
  };
  const receivedName = (frame) => {
    if (frame?.type === "projection_event") return `projection_event:${frame.stream}`;
    return ["welcome", "entered_ack", "live_target_result", "pong"].includes(frame?.type) ? frame.type : null;
  };
  const nativeSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function send(data) {
    const frame = parse(data);
    const name = sentName(frame);
    if (name) log("ws_out", name);
    return nativeSend.call(this, data);
  };
  function observeSocket(socket) {
    log("ws_new");
    socket.addEventListener("open", () => log("ws_open"));
    socket.addEventListener("message", (event) => {
      const frame = parse(event.data);
      const name = receivedName(frame);
      if (!name) return;
      log("ws_in", name);
    });
    return socket;
  }
  window.WebSocket = new Proxy(WebSocket, { construct: (target, args, newTarget) => observeSocket(Reflect.construct(target, args, newTarget)) });

  // SFU signaling goes through the API as HTTP; a reply is the response headers arriving.
  const SIGNAL_STEPS = { publications: "publications", subscriptions: "subscriptions", tracks: "tracks", tracks_close: "tracks/close", tracks_update: "tracks/update", renegotiate: "renegotiate" };
  const signalOp = (body) => parse(body)?.op;
  const nativeFetch = window.fetch;
  window.fetch = function traced(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "");
    const path = /\/media\/sfu\/([a-z/]+)(?:\?|$)/.exec(url)?.[1];
    if (!path) return Reflect.apply(nativeFetch, this, [input, init]);
    // The unified route carries the step in the body; the stages read the per-operation names.
    const step = path === "signal" ? (SIGNAL_STEPS[signalOp(init?.body)] ?? path) : path;
    const label = `${(init?.method ?? input?.method ?? "GET").toUpperCase()} ${step}`;
    log("http_start", label);
    return Reflect.apply(nativeFetch, this, [input, init]).then(
      (response) => {
        log("http_end", label);
        return response;
      },
      (error) => {
        log("http_failed", label);
        throw error;
      },
    );
  };

  // The SDK measures each credential read as a "chalk.sfu.credential" user-timing entry, detail {op}.
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.name === "chalk.sfu.credential") log("credential", `${entry.detail?.op} ${Math.round(entry.duration * 10) / 10}`);
  }).observe({ type: "measure", buffered: true });

  const NativePeer = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(NativePeer, {
    construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget);
      peer.addEventListener("connectionstatechange", () => {
        if (peer.connectionState === "connected") log("ice_connected");
      });
      return peer;
    },
  });

  window.proofTrace = {
    take: (from) => events.filter((event) => event.t >= from),

    // The selected candidate pair's current round trip to the SFU, lowest across connected peer connections, in ms. A pair without a current reading stays missing: its lifetime average is not a current round trip.
    async sfuRtt() {
      const values = [];
      for (const peer of window.proofConnections ?? []) {
        if (peer.connectionState !== "connected") continue;
        const report = await peer.getStats();
        let pair;
        for (const row of report.values()) if (row.type === "transport" && row.selectedCandidatePairId) pair = report.get(row.selectedCandidatePairId);
        if (!pair) for (const row of report.values()) if (row.type === "candidate-pair" && row.nominated && row.state === "succeeded") pair = row;
        const seconds = pair?.currentRoundTripTime;
        if (Number.isFinite(seconds)) values.push(seconds * 1000);
      }
      return values.length ? Math.round(Math.min(...values) * 10) / 10 : null;
    },

    // Cumulative audio receive counters summed over the connected peer connections. Two reads a window apart give averages for that window.
    async audioStats() {
      const total = { emitted: 0, jitterBufferDelay: 0, samples: 0, playoutDelay: 0, playoutReported: false };
      for (const peer of window.proofConnections ?? []) {
        if (peer.connectionState !== "connected") continue;
        for (const row of (await peer.getStats()).values()) {
          if (row.type !== "inbound-rtp" || (row.kind ?? row.mediaType) !== "audio") continue;
          total.emitted += row.jitterBufferEmittedCount ?? 0;
          total.jitterBufferDelay += row.jitterBufferDelay ?? 0;
          if (row.totalPlayoutDelay !== undefined && row.totalSamplesCount !== undefined) {
            total.playoutReported = true;
            total.playoutDelay += row.totalPlayoutDelay;
            total.samples += row.totalSamplesCount;
          }
        }
      }
      return total;
    },
  };
}
