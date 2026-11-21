const sharedRenderer = import("./renderer/paint.js").catch(() => null);
const shared = await sharedRenderer;
if (shared) {
  const font = new FontFace("Chalk Annotation Figtree", "url(renderer/Figtree-SemiBold.ttf)", { weight: "600" });
  document.fonts.add(await font.load());
}
export function paintFixture(canvas, view) {
  const { bounds, frame } = view.segment;
  const { width, height } = bounds;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  if (shared) {
    const { FRAME_UNITS, paintAnnotation } = shared;
    const nowMs = Date.now();
    const author = participant_id => ({ participant_id, generation: 1 });
    const draft = (points, color, id) => ({
      mark_id: String(id), lifetime: "fade", color,
      width: Math.max(1, Math.round(4 * devicePixelRatio / frame.width * FRAME_UNITS)),
      shape: { kind: "pen", points: points.map(point => ({
        x: Math.round(point.x * FRAME_UNITS), y: Math.round(point.y * FRAME_UNITS)
      })) }
    });
    paintAnnotation(ctx, {
      rect: { ...frame, x: frame.x - bounds.x, y: frame.y - bounds.y },
      clip: { x: 0, y: 0, width, height },
      nowMs, sharerId: "sharer", paused: view.paused,
      marks: view.strokes.map((stroke, index) => ({
        author: author(stroke.author),
        committed_at_ms: 0,
        created_revision: index + 1,
        expires_at_ms: stroke.ends_at_ms > Number.MAX_SAFE_INTEGER ? null : stroke.ends_at_ms,
        draft: draft(stroke.points, stroke.color, index)
      })),
      presence: view.draft.length ? [{
        author: author("sharer"), cursor: null, expires_at_ms: nowMs + 1000,
        draft: draft(view.draft, view.color, "draft")
      }] : []
    });
    return;
  }

  const draw = (points, color) => {
    if (points.length === 0) return;
    const x = point => point.x * frame.width + frame.x - bounds.x;
    const y = point => point.y * frame.height + frame.y - bounds.y;
    ctx.lineWidth = 4 * devicePixelRatio;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    const first = points[0];
    ctx.beginPath();
    ctx.moveTo(x(first), y(first));
    for (const point of points.slice(1)) ctx.lineTo(x(point), y(point));
    if (points.length === 1) ctx.lineTo(x(first) + 0.01, y(first));
    ctx.stroke();
  };

  for (const stroke of view.strokes) {
    if (!view.paused || stroke.author === "sharer") draw(stroke.points, stroke.color);
  }
  draw(view.draft, view.color);
}
