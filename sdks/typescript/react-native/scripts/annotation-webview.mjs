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
    const presence = trackPresence.update(samples, nowMs);
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
    samples = presence;
    localTouch = touch;
    serverNow = nowMs;
    receivedAt = performance.now();
    requestPaint();
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
