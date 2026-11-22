export function mount(engine) {
  if (!engine.paintAnnotation || !engine.createAnnotationPresenceTracker) return;
  const canvas = document.querySelector("canvas");
  const context = canvas.getContext("2d");
  if (!context) return;
  const trackPresence = engine.createAnnotationPresenceTracker();
  let scene;
  let samples = [];
  let localTouch = null;
  let serverNow = 0;
  let receivedAt = 0;
  let animation = 0;
  let presented;
  const heldInk = new Map();
  const committedIds = new Set();
  const stencil = document.createElement("canvas");
  const stencilContext = stencil.getContext("2d", { willReadFrequently: true });

  function unpack(frame) {
    const { width, height, rgb } = frame;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || Math.max(width, height) > 272) return null;
    const bytes = atob(rgb);
    if (bytes.length !== width * height * 3) return null;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < bytes.length; i += 3, j += 4) {
      data[j] = bytes.charCodeAt(i);
      data[j + 1] = bytes.charCodeAt(i + 1);
      data[j + 2] = bytes.charCodeAt(i + 2);
      data[j + 3] = 255;
    }
    return { width, height, data };
  }

  function buildProof(sample) {
    const baseline = presented && unpack(presented);
    if (!baseline || !stencilContext) return null;
    const { width, height } = baseline;
    stencil.width = width;
    stencil.height = height;
    engine.paintAnnotation(stencilContext, {
      rect: { x: 0, y: 0, width, height },
      marks: [],
      nowMs: sample.server_at_ms,
      presence: [sample],
    });
    return engine.makeStrokeProof(baseline, stencilContext.getImageData(0, 0, width, height));
  }

  function pendingInk(nowMs) {
    const active = [];
    for (const [id, preview] of heldInk) {
      const mark = scene.marks.find((item) => item.draft.mark_id === id);
      preview.revision ??= mark?.created_revision;
      const source = engine.inkHandoff({ baked: scene.burnedIn, revision: scene.revision, nowMs, mark, preview, proved: preview.proved });
      if (source === "local") active.push(preview.sample);
      else heldInk.delete(id);
    }
    return active;
  }

  function paint() {
    animation = 0;
    if (!scene) return;
    const scale = window.devicePixelRatio;
    const width = Math.round(canvas.clientWidth * scale);
    const height = Math.round(canvas.clientHeight * scale);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    const nowMs = serverNow + performance.now() - receivedAt;
    const presence = trackPresence.update([...samples, ...pendingInk(nowMs)], nowMs);
    const touch = localTouch?.untilMs > nowMs ? localTouch.point : undefined;
    engine.paintAnnotation(context, { ...scene, marks: scene.burnedIn ? [] : scene.marks, nowMs, presence, localTouch: touch });
    if (presence.length || touch || scene.marks.some((mark) => mark.expires_at_ms !== null && mark.expires_at_ms > nowMs)) {
      animation = requestAnimationFrame(paint);
    }
  }

  function requestPaint() {
    if (!animation) animation = requestAnimationFrame(paint);
  }

  window.chalkAnnotationScene = (next) => {
    scene = next;
    requestPaint();
  };
  window.chalkAnnotationPresence = (presence, nowMs, touch = null) => {
    samples = presence.filter((sample) => !committedIds.has(sample.draft?.mark_id));
    localTouch = touch;
    serverNow = nowMs;
    receivedAt = performance.now();
    requestPaint();
  };
  window.chalkAnnotationHoldInk = (sample) => {
    if (!sample.draft || !scene?.burnedIn || !engine.makeStrokeProof) return;
    const id = sample.draft.mark_id;
    committedIds.add(id);
    samples = samples.filter((live) => live.draft?.mark_id !== id);
    // Ambiguous or moving backgrounds provide no proof. The bounded fallback is not a frame match.
    heldInk.set(id, { sample, proof: buildProof(sample), startedBaked: true, expiresAt: sample.expires_at_ms, proofTimeoutAt: sample.expires_at_ms, proved: false });
    setTimeout(() => {
      heldInk.delete(id);
      committedIds.delete(id);
      requestPaint();
    }, engine.NATIVE_INK_PROOF_TIMEOUT_MS);
    requestPaint();
  };

  window.chalkAnnotationSettleInk = (id, revision) => {
    const preview = heldInk.get(id);
    if (!preview) return;
    if (revision === null) heldInk.delete(id);
    else preview.revision = revision;
    requestPaint();
  };

  window.chalkAnnotationPresented = (frame) => {
    presented = frame;
    if (!heldInk.size) return;
    const pixels = unpack(frame);
    if (!pixels) return;
    let changed = false;
    for (const preview of heldInk.values()) {
      if (preview.proof && engine.frameProvesStroke(pixels, preview.proof)) {
        preview.proved = changed = true;
      }
    }
    if (changed) {
      cancelAnimationFrame(animation);
      paint();
    }
  };

  window.chalkAnnotationSystemOverlay = (content, presence, nowMs) => {
    scene = {
      ...content,
      rect: { x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight },
      clip: { x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight },
    };
    window.chalkAnnotationPresence(presence, nowMs);
  };
  window.chalkAnnotationMeasure = async (request, samples) => {
    await document.fonts.load('600 16px "Chalk Annotation Figtree"');
    const measure = engine.canvasAnnotationTextMeasure(context);
    const widths = samples.map(([text, size]) => measure(text, size));
    window.ReactNativeWebView?.postMessage(JSON.stringify({ measure: request, widths }));
  };
  window.chalkAnnotationHit = (request, point, actor) => {
    if (!scene || !engine.hitTestAnnotation) return;
    const mark = engine.hitTestAnnotation(point, {
      ...scene,
      nowMs: serverNow + performance.now() - receivedAt,
      canErase: actor ? (mark) => mark.author.participant_id === actor : undefined,
      measureText: engine.canvasAnnotationTextMeasure(context),
    });
    window.ReactNativeWebView?.postMessage(JSON.stringify({ hit: request, markId: mark?.draft.mark_id ?? null }));
  };
  let exportJob;
  const exportPrefix = "data:image/png;base64,";
  const maxBytes = 16 * 1024 * 1024;
  window.chalkAnnotationExport = (id, frame) => {
    exportJob = { id, frame, chunks: [], length: 0 };
  };
  window.chalkAnnotationExportPart = async (id, part, final) => {
    const job = exportJob;
    if (!job || job.id !== id) return;
    job.length += part.length;
    if (job.length > maxBytes) {
      fail();
      return;
    }
    job.chunks.push(part);
    if (!final) return;
    try {
      const image = new Image();
      image.src = exportPrefix + job.chunks.join("");
      await image.decode();
      await document.fonts.ready;
      const frame = job.frame;
      if (image.naturalWidth !== frame.size.width || image.naturalHeight !== frame.size.height) throw new Error("Frame resized");
      const png = await engine.encodeAnnotationPng({ ...frame, image });
      const reader = new FileReader();
      const encoded = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(png);
      });
      if (typeof encoded !== "string" || !encoded.startsWith(exportPrefix) || encoded.length > maxBytes) throw new Error("PNG encoding failed");
      if (exportJob !== job) return;
      exportJob = undefined;
      const bytes = encoded.slice(exportPrefix.length);
      for (let at = 0; at < bytes.length; at += 32768) {
        window.ReactNativeWebView?.postMessage(JSON.stringify({ png: id, part: bytes.slice(at, at + 32768), final: at + 32768 >= bytes.length }));
      }
    } catch {
      fail();
    }

    function fail() {
      if (exportJob !== job) return;
      exportJob = undefined;
      window.ReactNativeWebView?.postMessage(JSON.stringify({ png: id, failed: true }));
    }
  };
  window.addEventListener("resize", requestPaint);
  document.fonts.ready.then(requestPaint);
}
