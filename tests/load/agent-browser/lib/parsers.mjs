export function parseEvalOutput(raw) {
  const cleaned = stripAnsi(raw).trim();
  const direct = parseJsonSmart(cleaned);
  if (direct.ok) return direct;

  const marker = cleaned.match(/AB_RESULT:\s*([\s\S]+)/);
  if (marker) {
    const markerParsed = parseJsonSmart(marker[1]);
    if (markerParsed.ok) return markerParsed;
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const objParsed = parseJsonSmart(cleaned.slice(firstBrace, lastBrace + 1));
    if (objParsed.ok) return objParsed;
  }

  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const arrParsed = parseJsonSmart(cleaned.slice(firstBracket, lastBracket + 1));
    if (arrParsed.ok) return arrParsed;
  }

  return { ok: false, value: null, raw: cleaned };
}

export function parseConsoleSignals(raw) {
  const parsed = safeJsonParse(raw);
  const messages = parsed?.data?.messages ?? [];
  const chalk = {};
  const chalkEvents = {};
  let corsCount = 0;
  let netErrCount = 0;
  let firstError = null;
  for (const msg of messages) {
    const text = msg?.text ?? "";
    if (/blocked by CORS policy/i.test(text)) corsCount += 1;
    if (/net::ERR_/i.test(text)) netErrCount += 1;
    if (!firstError && (msg?.type === "error" || /error|failed/i.test(text))) firstError = text.slice(0, 240);
    if (!text.startsWith("[Chalk]")) continue;
    const i = text.indexOf("{");
    if (i < 0) continue;
    const event = safeJsonParse(text.slice(i));
    if (!event?.eventType) continue;
    const summary = {
      eventId: event.eventId ?? null,
      timestamp: event.timestamp ?? null,
      sessionId: event.sessionId ?? null,
      roomId: event.roomId ?? null,
      durationMs: event.durationMs ?? null,
      phases: event.phases ?? null,
      outcome: event.outcome ?? null,
      requestPath: event?.data?.request?.path ?? null,
      statusCode: event?.data?.response?.statusCode ?? null,
      requestId: event?.data?.response?.requestId ?? null,
      traceId: event?.data?.response?.traceId ?? null,
      cfRay: event?.data?.response?.cfRay ?? null,
      inputRoomSlug: event?.data?.input?.roomId ?? null,
      participantId: event?.data?.api?.participantId ?? null,
    };
    chalk[event.eventType] = summary;
    if (!chalkEvents[event.eventType]) chalkEvents[event.eventType] = [];
    chalkEvents[event.eventType].push(summary);
  }
  return { messageCount: messages.length, corsCount, netErrCount, firstError, chalk, chalkEvents };
}

export function parseErrorsSignals(raw) {
  const parsed = safeJsonParse(raw);
  const errors = parsed?.data?.errors ?? [];
  return { errorCount: errors.length, first: errors[0] ?? null };
}

export function parseResourceSignals(entries) {
  const top = [...entries]
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, 8)
    .map((r) => ({ ms: Math.round(r.duration ?? 0), name: r.name }));
  return { count: entries.length, top };
}

function stripAnsi(input) {
  return input.replace(/\u001b\[[0-9;]*m/g, "");
}

function parseJsonSmart(input) {
  const text = String(input ?? "").trim();
  if (!text) return { ok: false, value: null };

  const first = safeJsonParse(text);
  if (first !== null) {
    if (typeof first === "string") {
      const second = safeJsonParse(first);
      if (second !== null) return { ok: true, value: second };
      const third = safeJsonParse(first.replace(/\\"/g, '"'));
      if (third !== null) return { ok: true, value: third };
      return { ok: false, value: null };
    }
    return { ok: true, value: first };
  }

  const unescaped = safeJsonParse(text.replace(/\\"/g, '"'));
  if (unescaped !== null) return { ok: true, value: unescaped };
  return { ok: false, value: null };
}

function safeJsonParse(input) {
  if (!input || typeof input !== "string") return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}
