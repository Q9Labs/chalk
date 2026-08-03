export function createMediaSmokeInitScript() {
  return String.raw`(() => {
    const state = {
      rtcConnections: new Set(),
      remoteTracks: new Map(),
      localTracks: new Set(),
      streams: new Set(),
      audioContexts: new Set(),
      frames: [],
      journeyIds: new Set(),
      hasRtcConnection: typeof window.RTCPeerConnection === "function",
      syntheticMediaError: undefined,
    };
    window.__chalkMediaSmoke = {
      stats: async () => {
        const rows = [];
        for (const rtcConnection of state.rtcConnections) {
          const report = await rtcConnection.getStats();
          report.forEach((entry) => {
            if (entry.type !== "inbound-rtp" && entry.type !== "outbound-rtp") return;
            rows.push({
              type: entry.type,
              kind: entry.kind || entry.mediaType,
              bytesReceived: Number.isFinite(entry.bytesReceived) ? entry.bytesReceived : 0,
              bytesSent: Number.isFinite(entry.bytesSent) ? entry.bytesSent : 0,
              packetsReceived: Number.isFinite(entry.packetsReceived) ? entry.packetsReceived : 0,
              packetsSent: Number.isFinite(entry.packetsSent) ? entry.packetsSent : 0,
            });
          });
        }
        return rows;
      },
      tracks: () => ({
        hasRtcConnection: state.hasRtcConnection,
        syntheticMediaError: state.syntheticMediaError,
        remote: Array.from(state.remoteTracks.values()).map((track) => ({ kind: track.kind, readyState: track.readyState, muted: track.muted })),
        frames: state.frames.slice(),
        journeyIds: Array.from(state.journeyIds),
      }),
    };

    const recordJourney = (value) => {
      if (typeof value === "string" && value.length > 0 && value.length <= 128) state.journeyIds.add(value);
    };
    const contextJourneyID = crypto.randomUUID();
    recordJourney(contextJourneyID);
    const recordFrame = (value) => {
      if (typeof value !== "string" || value.length > 200_000) return;
      let frame;
      try { frame = JSON.parse(value); } catch { return; }
      const entry = { type: typeof frame.type === "string" ? frame.type : undefined, outcome: typeof frame.outcome === "string" ? frame.outcome : undefined, code: typeof frame.code === "string" ? frame.code : undefined, reason: typeof frame.reason === "string" ? frame.reason : undefined, hasEventID: typeof frame.event_id === "string" && frame.event_id.length > 0, eventNames: [] };
      const names = new Set();
      const visit = (candidate, depth = 0) => {
        if (depth > 5 || candidate === null || typeof candidate !== "object") return;
        if (Array.isArray(candidate)) { candidate.forEach((item) => visit(item, depth + 1)); return; }
        for (const [key, item] of Object.entries(candidate)) {
          if (typeof item === "string" && /^(?:event|event_name|eventName|name)$/.test(key) && /^[a-z][a-z0-9_.-]{1,100}$/i.test(item)) names.add(item);
          if (/journey(?:_id|Id)?$/i.test(key)) recordJourney(item);
          visit(item, depth + 1);
        }
      };
      visit(frame);
      entry.eventNames = Array.from(names).slice(0, 20);
      state.frames.push(entry);
      if (state.frames.length > 300) state.frames.shift();
    };

    const OriginalWebSocket = window.WebSocket;
    if (typeof OriginalWebSocket === "function") {
      window.WebSocket = new Proxy(OriginalWebSocket, {
        construct(target, args) {
          const socket = Reflect.construct(target, args);
          socket.addEventListener("message", (event) => recordFrame(String(event.data)));
          return socket;
        },
      });
    }

    const OriginalFetch = window.fetch;
    if (typeof OriginalFetch === "function") {
      const isRequest = (input) => typeof Request === "function" && input instanceof Request;
      const localChalkURL = (input) => {
        try {
          const url = new URL(isRequest(input) ? input.url : input, window.location.href);
          return url.origin === window.location.origin && url.pathname.startsWith("/local-chalk/");
        } catch {
          return false;
        }
      };
      window.fetch = (...args) => {
        const input = args[0];
        const init = args[1];
        const requestInput = isRequest(input);
        const headers = new Headers(init?.headers !== undefined ? init.headers : requestInput ? input.headers : undefined);
        recordJourney(headers.get("x-chalk-journey-id"));
        if (!localChalkURL(input) || headers.has("x-chalk-journey-id")) return OriginalFetch(...args);
        headers.set("x-chalk-journey-id", contextJourneyID);
        if (requestInput) return OriginalFetch(new Request(input, { ...(init || {}), headers }));
        return OriginalFetch(input, { ...(init || {}), headers });
      };
    }

    const attachRtcConnection = (rtcConnection) => {
      state.rtcConnections.add(rtcConnection);
      rtcConnection.addEventListener("track", (event) => state.remoteTracks.set(event.track.id, event.track));
    };
    const OriginalRtcConnection = window.RTCPeerConnection;
    if (typeof OriginalRtcConnection === "function") {
      window.RTCPeerConnection = new Proxy(OriginalRtcConnection, {
        construct(target, args) {
          const rtcConnection = Reflect.construct(target, args);
          attachRtcConnection(rtcConnection);
          return rtcConnection;
        },
      });
    }

    const syntheticVideo = (label) => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext("2d");
      if (!context || typeof canvas.captureStream !== "function") throw new Error("canvas_capture_stream_unavailable");
      let frame = 0;
      const draw = () => {
        frame += 1;
        context.fillStyle = label === "screen" ? "#8b5cf6" : "#16a34a";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#ffffff";
        context.font = "24px sans-serif";
        context.fillText(label, 18, 42);
        context.fillText(String(frame), 18, 78);
      };
      draw();
      const timer = window.setInterval(draw, 100);
      const stream = canvas.captureStream(10);
      stream.getTracks().forEach((track) => {
        state.localTracks.add(track);
        track.addEventListener("ended", () => window.clearInterval(timer), { once: true });
      });
      state.streams.add(stream);
      return stream;
    };
    const syntheticAudio = () => {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (typeof AudioContextClass !== "function") throw new Error("audio_context_unavailable");
      const audioContext = new AudioContextClass();
      const oscillator = audioContext.createOscillator();
      const destination = audioContext.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      oscillator.connect(destination);
      oscillator.start();
      void audioContext.resume();
      state.audioContexts.add({ audioContext, oscillator });
      destination.stream.getTracks().forEach((track) => state.localTracks.add(track));
      state.streams.add(destination.stream);
      return destination.stream;
    };
    const syntheticStream = (constraints) => {
      try {
        const tracks = [];
        if (constraints?.audio) tracks.push(...syntheticAudio().getAudioTracks());
        if (constraints?.video) tracks.push(...syntheticVideo("camera").getVideoTracks());
        return new MediaStream(tracks);
      } catch (error) {
        state.syntheticMediaError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };
    if (!navigator.mediaDevices) navigator.mediaDevices = {};
    navigator.mediaDevices.getUserMedia = async (constraints) => syntheticStream(constraints || {});
    navigator.mediaDevices.getDisplayMedia = async (constraints) => {
      try { return new MediaStream(constraints?.audio ? [...syntheticVideo("screen").getVideoTracks(), ...syntheticAudio().getAudioTracks()] : syntheticVideo("screen").getVideoTracks()); }
      catch (error) { state.syntheticMediaError = error instanceof Error ? error.message : String(error); throw error; }
    };
  })()`;
}
