// Observe the real protocol and PeerConnection without changing SDK behavior.
export function installLeaveObservation() {
  const now = () => performance.timeOrigin + performance.now();
  const probe = (window.proofLeave = { sentAt: null, ackAt: null, peerCloses: [], rejections: [] });
  const observed = new WeakMap();
  function observeSocket(socket) {
    const state = { participant: null, command: null };
    observed.set(socket, state);
    socket.addEventListener("message", (event) => observeMessage(state, event.data));
    return socket;
  }
  window.WebSocket = new Proxy(WebSocket, { construct: (target, args) => observeSocket(Reflect.construct(target, args)) });
  function observeMessage(state, data) {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame.type === "welcome") state.participant = frame.participant_id;
    const acknowledged = frame.type === "ack" && frame.command_id === state.command && ["committed", "satisfied"].includes(frame.outcome);
    const departed = frame.type === "event" && frame.name === "participant_left" && frame.payload?.participant_id === state.participant;
    if (state.command && (acknowledged || departed)) probe.ackAt ??= now();
  }
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (!observed.has(this)) {
      observeSocket(this);
    }
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      /* Other frames are irrelevant. */
    }
    if (frame?.type === "operation" && frame.name === "participant_leave") {
      observed.get(this).command = frame.command_id;
      probe.sentAt ??= now();
      void window.proofReleasePublications?.();
    }
    return send.call(this, data);
  };
  const close = RTCPeerConnection.prototype.close;
  RTCPeerConnection.prototype.close = function (...args) {
    probe.peerCloses.push(now());
    return close.apply(this, args);
  };
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    if (response.status === 403 && new URL(url, location.href).pathname.endsWith("/media/sfu/publications")) {
      probe.rejections.push({ at: now(), lifecycle: window.proofClient.getSnapshot().connection.status });
    }
    return response;
  };
}
