/** Records one guest's signaling traffic and Sync socket events with `record`, and keeps the largest request body and the budget replacements in `state`. */
export function watchSignaling(page, guest, record, state) {
  const requests = new WeakMap();
  page.on("request", (request) => {
    const operation = signalingOperation(request.url());
    if (!operation) return;
    requests.set(request, performance.now());
    const body = signalingBody(request.postData(), request.url());
    state.signalBytes[guest] = Math.max(state.signalBytes[guest], body.bytes);
    if (body.replacementCause === "section_budget") state.budgetReplacements[guest].push(Date.now());
    record({ type: "signaling-request", operation, method: request.method(), ...(body.op ? { op: body.op } : {}), bytes: body.bytes, ...sdpOf(request) });
  });
  page.on("response", (response) => {
    const operation = signalingOperation(response.url());
    if (!operation) return;
    const started = requests.get(response.request());
    record({ type: "signaling-response", operation, status: response.status(), ...(started === undefined ? {} : { durationMs: performance.now() - started }) });
  });
  page.on("requestfailed", (request) => {
    const operation = signalingOperation(request.url());
    if (operation) record({ type: "request-failed", operation, error: signalingFailure(request) });
  });
  page.on("websocket", (socket) => {
    socket.on("socketerror", () => record({ type: "websocket-error" }));
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        record({ type: "websocket-frame", frameType: frame.type, event: frame.event, code: frame.code, status: frame.status });
      } catch {
        record({ type: "websocket-frame", bytes: payload.length });
      }
    });
  });
}
function signalingFailure(request) {
  const error = request.failure()?.errorText;
  return /^net::ERR_[A-Z_]+$/.test(error) ? error : "request_failed";
}

/** The size of a signaling request body, the operation a unified-route body names, and the replacement cause the request reports: in the JSON body on the unified route and in the query string on the per-operation routes. */
export function signalingBody(postData, url = "") {
  let op = null;
  let replacementCause = url ? new URL(url).searchParams.get("replacement_cause") : null;
  if (!postData) return { op, replacementCause, bytes: 0 };
  try {
    const parsed = JSON.parse(postData);
    if (typeof parsed?.op === "string") op = parsed.op;
    if (typeof parsed?.replacement_cause === "string") replacementCause = parsed.replacement_cause;
  } catch {
    // A body that is not JSON still has a size.
  }
  return { op, replacementCause, bytes: Buffer.byteLength(postData) };
}

/** The kind and size of the SDP a signalling request carries; a request without one adds nothing. The body is the guest's own, so the SDP itself stays out of the record. */
function sdpOf(request) {
  try {
    const description = JSON.parse(request.postData() ?? "{}").session_description;
    return description?.sdp ? { sdpType: description.type, sdpBytes: description.sdp.length } : {};
  } catch {
    return {};
  }
}

export function signalingOperation(url) {
  const path = new URL(url).pathname;
  const operation = /\/media\/sfu\/(signal|tracks\/close|tracks|renegotiate|publications)$/.exec(path)?.[1];
  return operation ?? (path.endsWith("/access-grant") ? "access-grant" : null);
}
