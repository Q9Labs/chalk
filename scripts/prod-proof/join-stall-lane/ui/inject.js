// Rehearsal instrumentation: synthetic capture (canvas video + oscillator audio), WebRTC stats, grant capture, error log.
(() => {
  if (window.__rehearsal) return;
  const R = (window.__rehearsal = { pcs: [], grants: [], logs: [], history: [], t0: Date.now(), name: "?", freq: 440, hue: 200 });
  const log = (kind, msg) => R.logs.push({ t: Date.now(), kind, msg: String(msg).slice(0, 300) });
  addEventListener("error", (e) => log("error", e.message));
  addEventListener("unhandledrejection", (e) => log("rejection", e.reason && (e.reason.message || e.reason)));
  for (const k of ["error", "warn"]) {
    const o = console[k].bind(console);
    console[k] = (...a) => {
      log("console." + k, a.map((x) => (x && x.message) || String(x)).join(" "));
      o(...a);
    };
  }
  // WebRTC peer connections
  const Orig = window.RTCPeerConnection;
  const P = function (...a) {
    const pc = new Orig(...a);
    R.pcs.push(pc);
    return pc;
  };
  P.prototype = Orig.prototype;
  Object.setPrototypeOf(P, Orig);
  window.RTCPeerConnection = P;
  // grants: find media.provider in any JSON response
  const scan = (url, v, depth = 0) => {
    if (!v || typeof v !== "object" || depth > 6) return;
    if (v.media && typeof v.media === "object" && v.media.provider) R.grants.push({ t: Date.now(), path: new URL(url, location.href).pathname.replace(/[0-9a-f-]{20,}/g, ":id"), provider: v.media.provider });
    for (const c of Object.values(v)) scan(url, c, depth + 1);
  };
  const of = window.fetch;
  window.fetch = async function (...a) {
    const r = await of.apply(this, a);
    try {
      const u = typeof a[0] === "string" ? a[0] : a[0].url;
      if ((r.headers.get("content-type") || "").includes("json"))
        r.clone()
          .json()
          .then(
            (j) => scan(u, j),
            () => {},
          );
    } catch {}
    return r;
  };
  // synthetic sources
  const clock = (canvas, label, hue, extra) => {
    const c = canvas.getContext("2d");
    const draw = () => {
      c.fillStyle = `hsl(${hue} 60% 35%)`;
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.fillStyle = "#fff";
      c.font = "bold 44px sans-serif";
      c.fillText(label, 24, 70);
      c.font = "bold 72px monospace";
      const d = new Date();
      c.fillText(d.toISOString().slice(11, 23), 24, canvas.height / 2 + 30);
      c.font = "28px sans-serif";
      c.fillText(extra || "", 24, canvas.height - 30);
      c.fillStyle = "#ff0";
      c.fillRect((Date.now() / 5) % canvas.width, canvas.height - 12, 40, 12);
    };
    draw();
    setInterval(draw, 33);
  };
  let audioCtx;
  const audioTrack = () => {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    osc.frequency.value = R.freq;
    const g = audioCtx.createGain();
    g.gain.value = 0.3;
    const dest = audioCtx.createMediaStreamDestination();
    osc.connect(g).connect(dest);
    osc.start();
    audioCtx.resume?.();
    return dest.stream.getAudioTracks()[0];
  };
  const cams = [];
  const videoTrack = (label, hue, w, h, extra) => {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    clock(cv, label, hue, extra);
    return cv.captureStream(30).getVideoTracks()[0];
  };
  const md = navigator.mediaDevices;
  md.getUserMedia = async (c = {}) => {
    const s = new MediaStream();
    if (c.video) s.addTrack(videoTrack(R.name, R.hue, 640, 360, "camera (synthetic canvas)"));
    if (c.audio) s.addTrack(audioTrack());
    return s;
  };
  md.getDisplayMedia = async () => {
    R.shareStarted = (R.shareStarted || 0) + 1;
    const s = new MediaStream([videoTrack(R.name + " SHARE", 20, 1280, 720, "screen share (synthetic moving clock)")]);
    s.getVideoTracks()[0].addEventListener("ended", () => (R.shareEnded = (R.shareEnded || 0) + 1));
    return s;
  };
  md.enumerateDevices = async () => [
    {
      kind: "audioinput",
      deviceId: "rehearsal-mic",
      label: "Rehearsal microphone",
      groupId: "r",
      toJSON() {
        return this;
      },
    },
    {
      kind: "videoinput",
      deviceId: "rehearsal-cam",
      label: "Rehearsal camera",
      groupId: "r",
      toJSON() {
        return this;
      },
    },
  ];
  const pq = navigator.permissions && navigator.permissions.query.bind(navigator.permissions);
  if (pq) navigator.permissions.query = (d) => (d && (d.name === "camera" || d.name === "microphone") ? Promise.resolve({ state: "granted", onchange: null, addEventListener() {}, removeEventListener() {} }) : pq(d));
  // sampling
  R.sample = async () => {
    const s = { t: Date.now(), pc: R.pcs.map((p) => p.connectionState + "/" + p.iceConnectionState), in: [], out: [], videos: [], pair: null };
    for (const pc of R.pcs) {
      if (pc.connectionState === "closed") continue;
      try {
        (await pc.getStats()).forEach((r) => {
          if (r.type === "inbound-rtp")
            s.in.push({
              k: r.kind,
              id: r.id,
              tid: r.trackIdentifier,
              mid: r.mid,
              b: r.bytesReceived,
              pk: r.packetsReceived,
              f: r.framesDecoded,
              kf: r.keyFramesDecoded,
              pli: r.pliCount,
              nack: r.nackCount,
              w: r.frameWidth,
              fps: r.framesPerSecond,
              e: r.totalAudioEnergy,
              lv: r.audioLevel,
              fz: r.freezeCount,
              lost: r.packetsLost,
              j: r.jitter,
            });
          else if (r.type === "outbound-rtp") s.out.push({ k: r.kind, b: r.bytesSent, f: r.framesSent, w: r.frameWidth, act: r.active });
          else if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) s.pair = { rtt: r.currentRoundTripTime };
        });
      } catch {}
    }
    for (const v of document.querySelectorAll("video")) {
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
      s.videos.push({ w: v.videoWidth, h: v.videoHeight, fr: q.totalVideoFrames, dr: q.droppedVideoFrames, p: v.paused, rs: v.readyState, vis: v.getBoundingClientRect().width > 0 });
    }
    return s;
  };
  R.start = (ms = 5000) => {
    clearInterval(R.timer);
    R.timer = setInterval(async () => {
      const s = await R.sample();
      R.history.push(s);
      if (R.history.length > 3000) R.history.shift();
    }, ms);
  };
  // UI helpers
  const norm = (s) => (s || "").trim().toLowerCase();
  R.find = (name) => [...document.querySelectorAll("button,[role=button],[role=menuitem]")].find((e) => norm(e.getAttribute("aria-label")) === norm(name) || norm(e.textContent) === norm(name));
  R.click = (name) => {
    const e = R.find(name);
    if (!e) return false;
    e.click();
    return true;
  };
  R.fill = (label, text) => {
    const i = [...document.querySelectorAll("input")].find((e) => norm(e.getAttribute("aria-label")) === norm(label) || (e.labels && [...e.labels].some((l) => norm(l.textContent) === norm(label))) || norm(e.placeholder) === norm(label));
    if (!i) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(i, text);
    i.dispatchEvent(new Event("input", { bubbles: true }));
    i.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  R.buttons = () =>
    [...document.querySelectorAll("button,[role=button]")]
      .map((e) => e.getAttribute("aria-label") || e.textContent.trim())
      .filter(Boolean)
      .slice(0, 60);
})();
