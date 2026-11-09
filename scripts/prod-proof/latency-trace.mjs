// Runs in a proof guest's page as an init script, installed after the fixture and only by the latency kit. It records
// timed wire events (Sync frames, SFU signaling replies, the first connected peer connection) without changing what
// the SDK sends or receives, the way installLeaveObservation does. The product SDK carries no trace code.
//
// Every time is performance.timeOrigin + performance.now(). Both guests run on one host, so those readings share the
// host's clock and compare across pages to within the browser's clock resolution (about 0.1 ms).
export function installLatencyTrace() {
  const now = () => performance.timeOrigin + performance.now();
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
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

  // Sync frames. A pong answers the oldest ping in flight, so the trace counts pings to keep its own probe from overlapping the SDK's.
  const waiters = [];
  let outstanding = 0;
  let syncSocket = null;
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
    if (frame?.type === "ping") outstanding++;
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
      if (frame.type === "welcome") syncSocket = socket;
      if (frame.type === "pong") {
        outstanding = Math.max(0, outstanding - 1);
        for (const done of waiters.splice(0)) done(now());
      }
    });
    return socket;
  }
  window.WebSocket = new Proxy(WebSocket, { construct: (target, args, newTarget) => observeSocket(Reflect.construct(target, args, newTarget)) });

  // SFU signaling goes through the API as HTTP; a reply is the response headers arriving.
  const nativeFetch = window.fetch;
  window.fetch = function traced(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "");
    const step = /\/media\/sfu\/([a-z/]+)(?:\?|$)/.exec(url)?.[1];
    if (!step) return Reflect.apply(nativeFetch, this, [input, init]);
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

  const median = (values) => (values.length ? values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)] : null);
  window.proofTrace = {
    take: (from) => events.filter((event) => event.t >= from),

    // The selected candidate pair's round trip to the SFU, lowest across connected peer connections, in ms.
    async sfuRtt() {
      const values = [];
      for (const peer of window.proofConnections ?? []) {
        if (peer.connectionState !== "connected") continue;
        const report = await peer.getStats();
        let pair;
        for (const row of report.values()) if (row.type === "transport" && row.selectedCandidatePairId) pair = report.get(row.selectedCandidatePairId);
        if (!pair) for (const row of report.values()) if (row.type === "candidate-pair" && row.nominated && row.state === "succeeded") pair = row;
        const seconds = pair?.currentRoundTripTime ?? (pair?.responsesReceived ? pair.totalRoundTripTime / pair.responsesReceived : undefined);
        if (Number.isFinite(seconds)) values.push(seconds * 1000);
      }
      return values.length ? Math.round(Math.min(...values) * 10) / 10 : null;
    },

    // One Sync ping and its pong, the median of three, in ms. A ping goes out only while none is in flight.
    async syncRtt() {
      const samples = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!syncSocket || syncSocket.readyState !== WebSocket.OPEN) break;
        for (let waited = 0; outstanding > 0 && waited < 1000; waited += 20) await pause(20);
        if (outstanding > 0) break;
        const answered = new Promise((done) => waiters.push(done));
        const sentAt = now();
        syncSocket.send('{"type":"ping"}');
        const pongAt = await Promise.race([answered, pause(2000).then(() => null)]);
        if (pongAt !== null) samples.push(pongAt - sentAt);
        await pause(100);
      }
      const value = median(samples);
      return value === null ? null : Math.round(value * 10) / 10;
    },
  };
}
