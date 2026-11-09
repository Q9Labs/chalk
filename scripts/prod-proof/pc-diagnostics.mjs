// Runs in a proof guest's page as an init script, installed after the fixture (it wraps the fixture's RTCPeerConnection).
// It records, without changing what the SDK sends or receives: every peer connection state change, the stack and state at
// each close(), the size and m-line count of each offer and answer and any setLocal/RemoteDescription failure, every
// media signaling request (path, body size, body connection id, the connection claim of its bearer token, status, timing)
// and the SDK snapshot transitions. Every time is performance.timeOrigin + performance.now().
export function installPcDiagnostics() {
  const now = () => performance.timeOrigin + performance.now();
  window.__pcDiag = [];
  const log = (k, extra) => window.__pcDiag.push({ t: now(), k, ...extra });
  const mlines = (sdp) => (sdp?.match(/^m=/gm) ?? []).length;
  const live = (sdp) => (sdp?.match(/^m=(?:audio|video) [1-9]/gm) ?? []).length;
  const sdpFacts = (description) => ({ type: description?.type, bytes: description?.sdp?.length ?? 0, mlines: mlines(description?.sdp), live: live(description?.sdp) });
  const trim = (stack) =>
    String(stack)
      .split("\n")
      .slice(1, 14)
      .map((line) => line.trim().replace(/https?:\/\/[^/]+\//, "/"));

  const Base = window.RTCPeerConnection;
  let counter = 0;
  window.RTCPeerConnection = class extends Base {
    constructor(...args) {
      super(...args);
      const id = ++counter;
      this.__diagId = id;
      log("pc_new", { pc: id });
      this.addEventListener("connectionstatechange", () => log("pc_state", { pc: id, connection: this.connectionState, ice: this.iceConnectionState, signaling: this.signalingState }));
      this.addEventListener("iceconnectionstatechange", () => log("pc_ice", { pc: id, ice: this.iceConnectionState, connection: this.connectionState }));
      this.addEventListener("signalingstatechange", () => log("pc_signaling", { pc: id, signaling: this.signalingState }));
    }
    close() {
      log("pc_close", { pc: this.__diagId, connection: this.connectionState, ice: this.iceConnectionState, signaling: this.signalingState, stack: trim(new Error().stack) });
      return super.close();
    }
    async createOffer(...args) {
      const offer = await super.createOffer(...args);
      log("offer", { pc: this.__diagId, ...sdpFacts(offer) });
      return offer;
    }
    async setLocalDescription(description) {
      const before = this.signalingState;
      try {
        const result = await super.setLocalDescription(description);
        log("set_local", { pc: this.__diagId, before, after: this.signalingState, ...sdpFacts(description ?? this.localDescription) });
        return result;
      } catch (error) {
        log("set_local_error", { pc: this.__diagId, before, error: `${error.name}: ${error.message}`.slice(0, 200), ...sdpFacts(description) });
        throw error;
      }
    }
    async setRemoteDescription(description) {
      const before = this.signalingState;
      try {
        const result = await super.setRemoteDescription(description);
        log("set_remote", { pc: this.__diagId, before, after: this.signalingState, ...sdpFacts(description) });
        return result;
      } catch (error) {
        log("set_remote_error", { pc: this.__diagId, before, error: `${error.name}: ${error.message}`.slice(0, 200), ...sdpFacts(description) });
        throw error;
      }
    }
  };

  const claim = (authorization) => {
    try {
      const payload = JSON.parse(
        atob(
          String(authorization)
            .replace(/^Bearer /, "")
            .split(".")[1]
            .replace(/-/g, "+")
            .replace(/_/g, "/"),
        ),
      );
      const keys = Object.keys(payload).filter((key) => /conn/i.test(key));
      return { claims: Object.fromEntries(keys.map((key) => [key, payload[key]])), exp: payload.exp };
    } catch {
      return { claims: null, exp: null };
    }
  };
  const bodyFacts = (body) => {
    if (typeof body !== "string") return { bodyBytes: body?.size ?? body?.byteLength ?? null, bodyConnectionId: null };
    try {
      const parsed = JSON.parse(body);
      return { bodyBytes: body.length, bodyConnectionId: parsed.connection_id ?? parsed.connectionId ?? null, sdpBytes: parsed.session_description?.sdp?.length ?? parsed.sessionDescription?.sdp?.length ?? null };
    } catch {
      return { bodyBytes: body.length, bodyConnectionId: null };
    }
  };
  const nativeFetch = window.fetch.bind(window);
  let requests = 0;
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input.url ?? String(input));
    const marker = url.indexOf("/media/sfu");
    if (marker < 0) return nativeFetch(input, init);
    const id = ++requests;
    const startedAt = now();
    const headers = new Headers(init?.headers ?? (typeof input === "object" ? input.headers : undefined));
    const bearer = claim(headers.get("authorization"));
    log("req", { id, path: url.slice(marker + "/media/sfu".length).replace(/\?.*/, ""), method: init?.method ?? "GET", ...bodyFacts(init?.body), tokenClaims: bearer.claims, tokenExp: bearer.exp, aborted: init?.signal?.aborted ?? false });
    init?.signal?.addEventListener("abort", () => log("req_abort", { id, afterMs: Math.round(now() - startedAt), reason: String(init.signal.reason?.name ?? init.signal.reason).slice(0, 80) }), { once: true });
    try {
      const response = await nativeFetch(input, init);
      const body = url.includes("/subscriptions")
        ? await response
            .clone()
            .text()
            .then(
              (text) => text.slice(0, 1500),
              () => null,
            )
        : undefined;
      log("res", { id, status: response.status, ms: Math.round(now() - startedAt), ...(body === undefined ? {} : { body }) });
      return response;
    } catch (error) {
      log("res_error", { id, error: `${error.name}: ${error.message}`.slice(0, 160), ms: Math.round(now() - startedAt) });
      throw error;
    }
  };

  let last = "";
  setInterval(() => {
    const snapshot = window.proofClient?.getSnapshot?.();
    if (!snapshot) return;
    const view = { status: snapshot.connection.status, error: snapshot.connection.lastError?.code ?? null, mic: snapshot.media.local.microphone.state, camera: snapshot.media.local.camera.state, remotes: snapshot.media.remote.length };
    const key = JSON.stringify(view);
    if (key !== last) {
      last = key;
      log("snapshot", view);
    }
  }, 250);
}
