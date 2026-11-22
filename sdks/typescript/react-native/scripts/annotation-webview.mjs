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
  let latestRaster;
  let decodedSampleId = 0;
  let systemOverlay = false;
  const heldInk = new Map();
  const exportInk = new Map();
  const committedIds = new Set();
  const stencil = document.createElement("canvas");
  const stencilContext = stencil.getContext("2d", { willReadFrequently: true });
  const decodedCanvas = document.createElement("canvas");
  const decodedContext = decodedCanvas.getContext("2d", { willReadFrequently: true });

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
    const baseline = latestRaster;
    if (!baseline) return undefined;
    if (!stencilContext) return null;
    const { width, height } = baseline;
    stencil.width = width;
    stencil.height = height;
    engine.paintAnnotation(stencilContext, {
      rect: { x: 0, y: 0, width, height },
      marks: [],
      nowMs: sample.server_at_ms,
      presence: [sample],
    });
    return engine.makeBakedStrokeProof(baseline, stencilContext.getImageData(0, 0, width, height));
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
    const bounds = { x: 0, y: 0, width: canvas.clientWidth, height: canvas.clientHeight };
    const layout = systemOverlay ? { rect: bounds, clip: bounds } : scene;
    engine.paintAnnotation(context, { ...scene, ...layout, marks: scene.burnedIn ? [] : scene.marks, nowMs, presence, localTouch: touch });
    if (presence.length || touch || scene.marks.some((mark) => mark.expires_at_ms !== null && mark.expires_at_ms > nowMs)) {
      animation = requestAnimationFrame(paint);
    }
  }

  function requestPaint() {
    if (!animation) animation = requestAnimationFrame(paint);
  }

  window.chalkAnnotationScene = (next) => {
    scene = next;
    for (const [id, preview] of exportInk) {
      if (!scene.burnedIn || (preview.revision !== undefined && scene.revision >= preview.revision && !scene.marks.some((mark) => mark.draft.mark_id === id))) exportInk.delete(id);
    }
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
    if (!sample.draft || !scene?.burnedIn || !engine.makeBakedStrokeProof) return;
    const id = sample.draft.mark_id;
    committedIds.add(id);
    samples = samples.filter((live) => live.draft?.mark_id !== id);
    // Ambiguous or moving backgrounds provide no proof. The bounded fallback is not a frame match.
    const preview = { sample, proof: buildProof(sample), startedBaked: true, expiresAt: sample.expires_at_ms, proofTimeoutAt: sample.expires_at_ms, proved: false };
    heldInk.set(id, preview);
    trackExportInk(id, preview);
    setTimeout(() => {
      heldInk.delete(id);
      committedIds.delete(id);
      requestPaint();
    }, engine.INK_PROOF_TIMEOUT_MS);
    requestPaint();
  };

  function notifyInk(id, handoff = false) {
    window.ReactNativeWebView?.postMessage(JSON.stringify({ bakedInk: id, handoff }));
  }

  function trackExportInk(id, preview) {
    if (preview.proof === null) {
      notifyInk(id);
      return;
    }
    exportInk.set(id, preview);
    setTimeout(() => {
      if (exportInk.get(id) === preview) exportInk.delete(id);
    }, engine.INK_PROOF_TIMEOUT_MS);
  }

  window.chalkAnnotationWatchInk = (sample, revision) => {
    if (!sample.draft || !engine.makeBakedStrokeProof) return;
    trackExportInk(sample.draft.mark_id, { proof: buildProof(sample), revision, sample });
  };

  window.chalkAnnotationSettleInk = (id, revision) => {
    const preview = heldInk.get(id) ?? exportInk.get(id);
    if (!preview) return;
    if (revision === null) {
      heldInk.delete(id);
      exportInk.delete(id);
    } else preview.revision = revision;
    requestPaint();
  };

  function observeInk(pixels, presented) {
    if (!pixels) return;
    latestRaster = pixels;
    let changed = false;
    for (const [id, preview] of exportInk) {
      if (preview.proof === undefined) preview.proof = buildProof(preview.sample);
      if (preview.proof === null || (preview.proof && engine.frameContainsStroke(pixels, preview.proof))) {
        exportInk.delete(id);
        notifyInk(id);
      }
    }
    // A spatial match can unblock save but does not retire live local ink.
    if (presented) {
      for (const [id, preview] of heldInk) {
        if (preview.proof?.changed && engine.frameProvesStroke(pixels, preview.proof.changed)) {
          preview.proved = changed = true;
          notifyInk(id, true);
        }
      }
    }
    if (changed) {
      cancelAnimationFrame(animation);
      paint();
    }
  }

  window.chalkAnnotationPresented = (frame) => observeInk(unpack(frame), true);
  window.chalkAnnotationDecodedSample = async (png) => {
    if (!decodedContext) return;
    const id = ++decodedSampleId;
    const image = new Image();
    image.src = "data:image/png;base64," + png;
    try {
      await image.decode();
    } catch {
      return;
    }
    if (id !== decodedSampleId || Math.max(image.naturalWidth, image.naturalHeight) > 273) return;
    decodedCanvas.width = image.naturalWidth;
    decodedCanvas.height = image.naturalHeight;
    decodedContext.drawImage(image, 0, 0);
    observeInk(decodedContext.getImageData(0, 0, decodedCanvas.width, decodedCanvas.height), false);
  };

  window.chalkAnnotationSystemOverlay = (content, nowMs) => {
    systemOverlay = true;
    scene = content;
    samples = [];
    serverNow = nowMs;
    receivedAt = performance.now();
    cancelAnimationFrame(animation);
    paint();
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
