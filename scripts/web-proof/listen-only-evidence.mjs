function responseKind(response) {
  const path = new URL(response.url()).pathname;
  if (path === "/v1/public/space-invite-arrival/access-grants") return "renewal";
  return isArrivalResponse(path, response.request().method()) ? "arrival" : mediaErrorResponse(path, response.status());
}

function isArrivalResponse(path, method) {
  return path === "/v1/public/space-invite-arrivals" || (path === "/v1/public/space-invite-arrival" && method === "GET");
}

function mediaErrorResponse(path, status) {
  return path.startsWith("/v1/") && [404, 409].includes(status) ? "error" : null;
}

export function observeResponses(page, evidence) {
  const initial = {};
  const responses = [];
  page.on("response", (response) => {
    const kind = responseKind(response);
    if (!kind) return;
    const renewal = kind === "renewal" ? { status: response.status(), sameBinding: false, extendedExpiry: false } : null;
    if (renewal) evidence.refreshes.push(renewal);
    responses.push(
      response
        .json()
        .then((body) => recordResponse(body, kind, initial, renewal, evidence))
        .catch(() => {}),
    );
  });
  return responses;
}

function recordResponse(body, kind, initial, renewal, evidence) {
  if (kind === "arrival") recordInitialGrant(initial, body.access);
  if (renewal) compareGrant(renewal, body.media, initial.media);
  recordMediaError(body, evidence);
}

function recordInitialGrant(initial, access) {
  initial.media ??= access?.media;
}

function compareGrant(renewal, media, initial) {
  if (!initial || !media) return;
  renewal.sameBinding = media.client_payload.connectionId === initial.client_payload.connectionId;
  renewal.extendedExpiry = media.expires_at > initial.expires_at;
}

function recordMediaError(body, evidence) {
  const code = body.error?.code ?? body.code;
  if (["media.connection_not_found", "access.media_proof_expired"].includes(code)) evidence.mediaErrors.push(code);
}
