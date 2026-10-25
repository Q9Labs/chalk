// Dev-only stand-in for the dashboard's Pages Functions, so the browser half can be driven
// without external identity providers or the engine. It answers /auth/* and /dashboard-api/* with the contract's DTO
// shapes, proxies everything else (and Vite's HMR socket) to the Vite dev server, and records
// every request for the browser checks. It lives outside src/, so no build can bundle it.
//
//   node tests/dashboard-ui/fixture-server.mjs   (Vite on 3070, fixture on 3071)
//   GET /__fixture/set?account=hasan|new&delay=ms&fail=home&limit=call&expire=1&freshSignIn=create-key&session=<id>&newCall=<name>
//   GET /__fixture/log   GET /__fixture/reset
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { readFileSync, existsSync } from "node:fs";

const PORT = Number(process.env.FIXTURE_PORT ?? 3071);
const VITE = new URL(process.env.VITE_ORIGIN ?? "http://127.0.0.1:3070");
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIDEO = process.env.FIXTURE_VIDEO ?? "/tmp/dashui/session.mp4";

const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (daysAgo, hh, mm) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hh, mm, 0, 0);
  return date.toISOString();
};
const plus = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60000).toISOString();

const PROFILES = {
  hasan: { name: "Hasan Shoaib", email: "hasan@q9labs.ai", avatarUrl: null },
  new: { name: "June Park", email: "june@example.com", avatarUrl: null },
};

function richAccount() {
  const calls = [
    ["Q9 team", "q9-team", 30],
    ["Design review", "design-review", 25],
    ["TH tutor sync", "th-tutors", 20],
    ["Weekly planning", "weekly", 14],
    ["Ali Raza intro", "k4f-82m", 10],
  ].map(([name, slug, days], i) => ({ id: uuid(0x100 + i), slug, name, archived: false, admission: i === 0 ? "knock" : "anyone", createdAt: at(days, 9, 0) }));
  // What Home shows for calls with no sessions here: when they were last used, and who came most recently.
  const recent = [null, [at(1, 16, 30), ["Priya Shah", "Eli Cohen"]], [at(3, 11, 0), ["Ali Raza", "Lena Vogel", "Malik Haddad"]], [at(6, 10, 0), ["Akash Rao", "June Park", "Lena Vogel", "Nora Patel"]], [null, []]];
  calls.forEach((call, i) => {
    if (recent[i]) [call.lastActiveAt, call.recentPeople] = [recent[i][0], recent[i][1].map((name, n) => ({ id: uuid(0x6100 + i * 16 + n), name }))];
  });
  const people = ["Hasan Shoaib", "Nora Patel", "Akash Rao", "Sofia Lind", "Malik Haddad", "Priya Shah", "Eli Cohen", "Ali Raza"];
  const sessions = [
    [0, 10, 2, 46, 5, "done"],
    [3, 16, 30, 42, 4, "processing"],
    [5, 10, 0, 21, 3, "none"],
    [6, 10, 1, 54, 6, "done"],
    [10, 10, 3, 27, 2, "done"],
    [12, 10, 0, 41, 5, "done"],
    [13, 9, 58, 22, 4, "none"],
    [17, 10, 0, 33, 4, "done"],
    [19, 10, 0, 30, 3, "done"],
  ].map(([days, hh, mm, length, count, kept], i) => {
    const startedAt = at(days, hh, mm);
    return { id: uuid(0x200 + i), status: "ended", startedAt, endedAt: plus(startedAt, length), people: people.slice(0, count), kept };
  });
  calls[0].lastActiveAt = sessions[0].endedAt;
  calls[0].recentPeople = sessions[0].people.slice(1).map((name, n) => ({ id: uuid(0x700 + n + 1), name }));
  return {
    calls,
    sessions,
    live: false,
    keys: [
      {
        id: uuid(0x300),
        name: "TH portal production",
        prefix: "chalk_sk_7Hq2",
        scopes: ["spaces:read", "spaces:write", "episodes:read", "episodes:write", "recordings:read", "recordings:write", "transcriptions:read", "transcriptions:write", "webhooks:read", "webhooks:write"],
        expiresAt: at(-319, 12, 0),
        revokedAt: null,
        lastUsedAt: new Date(Date.now() - 2 * 60000).toISOString(),
      },
      { id: uuid(0x301), name: "MCP server", prefix: "chalk_sk_k91P", scopes: ["spaces:read", "episodes:read", "recordings:read", "transcriptions:read", "webhooks:read"], expiresAt: at(-83, 12, 0), revokedAt: null, lastUsedAt: at(1, 15, 20) },
      { id: uuid(0x302), name: "Staging", prefix: "chalk_sk_Zt4m", scopes: ["spaces:read", "spaces:write", "episodes:read", "episodes:write"], expiresAt: at(-5, 12, 0), revokedAt: null, lastUsedAt: at(21, 9, 40) },
    ],
    webhooks: [
      { id: uuid(0x400), name: "TH attendance", url: "https://api.tuitionhighway.com/chalk/…", enabled: true, revision: 3, eventTypes: ["participant.joined", "participant.left", "episode.started", "episode.ended"] },
      { id: uuid(0x401), name: "Recordings to Drive", url: "https://hooks.q9labs.ai/chalk/…", enabled: true, revision: 1, eventTypes: ["recording.completed", "transcript.completed"] },
    ],
    deliveries: {
      [uuid(0x400)]: [
        { id: uuid(0x500), state: "failed", createdAt: at(0, 10, 49), eventType: "participant.left", attempts: 1, status: 401 },
        { id: uuid(0x501), state: "retrying", createdAt: at(0, 10, 48), eventType: "episode.ended", attempts: 3, status: 503 },
        { id: uuid(0x502), state: "delivered", createdAt: at(0, 10, 48), eventType: "participant.left", attempts: 1, status: 200 },
        { id: uuid(0x503), state: "delivered", createdAt: at(0, 10, 9), eventType: "participant.joined", attempts: 1, status: 200 },
        { id: uuid(0x504), state: "delivered", createdAt: at(0, 10, 2), eventType: "episode.started", attempts: 1, status: 200 },
      ],
      [uuid(0x401)]: [{ id: uuid(0x505), state: "delivered", createdAt: at(0, 11, 2), eventType: "recording.completed", attempts: 1, status: 200 }],
    },
    origins: ["https://chalkmeet.com", "https://portal.tuitionhighway.com", "https://app.q9labs.ai", "http://localhost:5173"],
  };
}
const emptyAccount = () => ({ calls: [], sessions: [], live: false, keys: [], webhooks: [], deliveries: {}, origins: ["https://chalkmeet.com"] });

const TRANSCRIPT = [
  [12, "Nora Patel", "Morning. Can everyone hear me?"],
  [18, "Akash Rao", "Loud and clear."],
  [41, "Hasan Shoaib", "Let’s start with the launch date. Where are we?"],
  [65, "Nora Patel", "The call page is done. The phone build goes to review on Tuesday."],
  [92, "Sofia Lind", "I’d move the launch to Friday, so review has two clear days."],
  [110, "Hasan Shoaib", "Friday works. Akash, does that fit the API side?"],
  [124, "Akash Rao", "Yes. The recording fix lands Monday, so Friday is safe."],
  [151, "Malik Haddad", "I’ll tell the TH team about the new date today."],
  [190, "Sofia Lind", "Next, the docs. The quickstart still says Space in its first line."],
  [206, "Nora Patel", "That’s right for the docs. Developers see Space in the API."],
  [242, "Hasan Shoaib", "Agreed. Space and Episode stay in the docs. Everywhere else, it’s a call."],
  [280, "Akash Rao", "One more thing. Webhook deliveries to TH failed twice this week."],
  [298, "Akash Rao", "Their endpoint returned 401 after they rotated the signing secret."],
  [321, "Malik Haddad", "I’ll ask them to accept both secrets during the overlap."],
  [2650, "Sofia Lind", "I’ll write up the launch notes and share them in chat."],
  [2731, "Hasan Shoaib", "Thanks, everyone. Same link on Tuesday."],
];
const SEAT = (name) => uuid(0x700 + ["Hasan Shoaib", "Nora Patel", "Akash Rao", "Sofia Lind", "Malik Haddad", "Priya Shah", "Eli Cohen", "Ali Raza"].indexOf(name));

let state;
let accounts;
const log = [];
function reset() {
  state = { liveParticipantCount: 3, account: "hasan", delay: 0, fail: new Set(), limit: new Set(), expire: false, freshSignIn: new Set(), transcript: "completed", signInError: false };
  accounts = { hasan: richAccount(), new: emptyAccount() };
  log.length = 0;
}
reset();

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}
const fail = (response, status, code, extra = {}) => send(response, status, { error: { code, ...extra } }, status === 429 ? { "Retry-After": "60" } : {});
function cookies(request) {
  return Object.fromEntries(
    (request.headers.cookie ?? "")
      .split(/;\s*/)
      .filter(Boolean)
      .map((part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)]),
  );
}
const csrfFor = (account) => `fixture-csrf-${account}`;
class RequestBodyTooLarge extends Error {}
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FIXTURE_DELAY_MS = 1000;
async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      request.resume();
      throw new RequestBodyTooLarge();
    }
    chunks.push(chunk);
  }
  return bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const callDTO = ({ lastActiveAt: _last, recentPeople: _people, ...call }) => call;
const homeCallDTO = (call) => ({ ...callDTO(call), inviteUrl: null, lastActiveAt: call.lastActiveAt ?? null, recentPeople: call.recentPeople ?? [] });
const episodeDTO = ({ people: _people, kept: _kept, ...episode }) => episode;
const inviteCode = (call) => {
  const letters = call.id
    .replaceAll("-", "")
    .slice(-10)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
  return `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`;
};
const inviteURL = (call) => `https://chalkmeet.com/${inviteCode(call)}`;
const transcriptsFor = (createdAt) => (state.transcript === "none" ? [] : [{ id: uuid(0x900), status: state.transcript, languages: ["en"], createdAt }]);
function recordingScenario() {
  if (!state.recordingScenario) return {};
  // A deadline set with expireIn closes the source window by this server's clock, as the API does.
  const mode = state.expireAt && Date.now() >= state.expireAt ? "expired" : state.recordingScenario;
  const failed = mode === "failed";
  const expired = mode === "expired";
  const pending = mode === "pending";
  return {
    status: mode === "export_ready" ? "completed" : "pending",
    sourceStatus: failed ? "failed" : expired ? "expired" : pending ? "pending" : "available",
    exportStatus: mode === "export_expired" || expired ? "unavailable" : failed || pending ? "unavailable" : mode === "export_pending" ? "pending" : mode === "export_ready" ? "ready" : ["export_failed", "export_exhausted"].includes(mode) ? "failed" : "none",
    exportRetryable: mode === "export_failed",
    failureMessage:
      mode === "export_expired"
        ? "The recording could not be rendered before its deadline."
        : failed
          ? "The recording capture did not complete."
          : expired
            ? "The recording source is no longer available."
            : ["export_failed", "export_exhausted"].includes(mode)
              ? "The recording export could not be completed."
              : null,
    sourceExpiresAt: state.expireAt ? new Date(state.expireAt).toISOString() : null,
    transcriptionExpiresAt: null,
    transcriptionStatus: failed || mode === "transcript_failed" ? "failed" : expired ? "expired" : pending ? "pending" : "ready",
  };
}

const recordingsFor = (episode, withTranscripts) =>
  episode.kept === "none"
    ? []
    : [
        {
          id: uuid(0x800),
          status: episode.kept === "processing" ? "processing" : "completed",
          sourceStatus: episode.kept === "processing" ? "pending" : "available",
          exportStatus: episode.kept === "processing" ? "unavailable" : "ready",
          exportRetryable: false,
          failureMessage: null,
          transcriptionStatus: state.transcriptionPending ? "pending" : "ready",
          sourceExpiresAt: null,
          transcriptionExpiresAt: null,
          createdAt: episode.startedAt,
          ...recordingScenario(),
          // A recording scenario lists the same transcripts on every read, as the server's one transcript list does.
          ...(withTranscripts
            ? {
                transcripts: state.recordingScenario ? transcriptsFor(episode.endedAt) : state.hideTranscripts ? [] : [{ id: uuid(0x900), status: episode.kept === "processing" ? "processing" : (state.finishedTranscript ?? "completed"), languages: ["en"], createdAt: episode.endedAt }],
              }
            : {}),
        },
      ];

async function auth(request, response, path, url) {
  if (path === "/auth/start") {
    const provider = url.searchParams.get("provider");
    const returnTo = url.searchParams.get("returnTo") ?? "/dashboard";
    if (!["google", "apple"].includes(provider) || !/^\/dashboard(?:\/[a-zA-Z0-9/_-]*)?$/.test(returnTo)) return fail(response, 400, "invalid_request");
    await wait(600);
    if (state.signInError) {
      response.writeHead(303, { Location: `/dashboard/sign-in?failed=${provider}` }).end();
      return;
    }
    response.writeHead(303, { Location: returnTo, "Set-Cookie": `fx_session=${state.account}; Path=/; HttpOnly; SameSite=Lax` }).end();
    return;
  }
  const account = cookies(request).fx_session;
  if (path === "/auth/session") {
    if (!account) return fail(response, 401, "sign_in_required");
    if (state.expire) return fail(response, 401, "sign_in_required");
    return send(response, 200, { profile: PROFILES[account], csrfToken: csrfFor(account) });
  }
  if (request.method !== "POST") return fail(response, 405, "method_not_allowed");
  if (request.headers.origin !== ORIGIN) return fail(response, 403, "origin_rejected");
  if (!account) return fail(response, 401, "sign_in_required");
  if (request.headers["x-csrf-token"] !== csrfFor(account)) return fail(response, 403, "csrf_rejected");
  if (path === "/auth/sign-out") {
    response.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "fx_session=; Path=/; Max-Age=0" });
    response.end(JSON.stringify({ ok: true, clearLocalBookmarks: true }));
    return;
  }
  return fail(response, 404, "route_not_found");
}

function homeDTO(data) {
  const calls = data.calls.filter((call) => !call.archived);
  const live = calls.map((call, i) => ({ spaceId: call.id, episode: data.live && i === 0 ? { id: uuid(0x2ff), count: 3, participants: ["Nora Patel", "Akash Rao", "Sofia Lind"].map((name, n) => ({ id: uuid(0x600 + n), name })) } : null }));
  return { calls: calls.map(homeCallDTO), live, nextCursor: null };
}

async function dashboard(request, response, page, url, entry) {
  const account = cookies(request).fx_session;
  if (request.method === "POST" && request.headers.origin !== ORIGIN) return fail(response, 403, "origin_rejected");
  if (!account) return fail(response, 401, "sign_in_required");
  if (state.expire) return fail(response, 401, "sign_in_required");
  if (request.method === "POST" && request.headers["x-csrf-token"] !== csrfFor(account)) return fail(response, 403, "csrf_rejected");
  const data = accounts[account];
  if (request.method === "GET") {
    if (state.delay) await wait(state.delay);
    if (state.limit.has(page)) return fail(response, 429, "engine_rate_limited", { retryable: true, retryAfterSeconds: 60 });
    if (state.fail.has(page)) return fail(response, 503, "service_unavailable");
    const query = Object.fromEntries(url.searchParams);
    if (page === "home-status") {
      const participants = ["Nora Patel", "Akash Rao", "Sofia Lind"].slice(0, state.liveParticipantCount).map((name, n) => ({ id: uuid(0x600 + n), name }));
      const ids = query.spaceIds ? query.spaceIds.split(",") : [];
      const live = ids.map((spaceId) => ({ spaceId, episode: data.live && spaceId === data.calls[0]?.id ? { id: uuid(0x2ff), count: participants.length, participants } : null }));
      // Like the server: every row's activity, and with `home` the first page when the newest call isn't listed.
      const calls = ids
        .map((spaceId) => data.calls.find((call) => call.id === spaceId))
        .filter(Boolean)
        .map(homeCallDTO)
        .map(({ id, archived, lastActiveAt, recentPeople }) => ({ id, archived, lastActiveAt, recentPeople }));
      if (!query.home) return send(response, 200, { live, calls });
      const newest = data.calls.find((call) => !call.archived)?.id;
      return send(response, 200, newest && !ids.includes(newest) ? { live, calls, first: homeDTO(data) } : { live, calls });
    }
    if (page === "call-metadata") {
      if (query.kind === "recording" && state.recordingScenario === "missing") return fail(response, 404, "recording_not_found");
      const recordings = data.sessions.flatMap((session) => recordingsFor(session, true));
      if (query.kind === "recording") return send(response, 200, { kind: "recording", recording: recordings.find((item) => item.id === query.id && item.status === "processing") ?? recordings.find((item) => item.id === query.id) });
      return send(response, 200, { kind: "transcript", transcript: recordings.flatMap((item) => item.transcripts ?? []).find((item) => item.id === query.id && item.status === "processing") ?? recordings.flatMap((item) => item.transcripts ?? []).find((item) => item.id === query.id) });
    }
    if (page === "call-status") {
      const episode = data.live ? { id: uuid(0x2ff), status: "active" } : data.sessions.find((item) => item.status !== "ended");
      return send(response, 200, { latestEpisodeId: data.live ? uuid(0x2ff) : (data.sessions[0]?.id ?? null), episode: episode ? { id: episode.id, status: episode.status } : null, knocks: data.knocks ?? [] });
    }
    if (page === "home") return send(response, 200, homeDTO(data));
    if (page === "call-invite") {
      const call = data.calls.find((item) => item.id === query.spaceId);
      return call ? send(response, 200, { inviteUrl: inviteURL(call) }) : fail(response, 404, "not_found");
    }
    if (page === "call") {
      const call = data.calls.find((item) => item.id === query.spaceId);
      if (!call) return fail(response, 404, "not_found");
      const own = call === data.calls[0] ? data.sessions : [];
      const start = Number(query.cursor ?? 0);
      const episodes = own.slice(start, start + 7).map((episode) => ({ ...episodeDTO(episode), participantCount: episode.people.length, recordings: recordingsFor(episode, true), recordingsNextCursor: null }));
      const isLive = data.live && call === data.calls[0];
      const participants = ["Nora Patel", "Akash Rao", "Sofia Lind"].slice(0, state.liveParticipantCount).map((name, n) => ({ id: uuid(0x600 + n), name }));
      if (isLive && !query.cursor) episodes.unshift({ id: uuid(0x2ff), status: "active", startedAt: at(0, 10, 2), endedAt: null, participantCount: participants.length, recordings: [], recordingsNextCursor: null });
      const live = isLive ? { id: uuid(0x2ff), count: participants.length, participants } : null;
      return send(response, 200, { call: callDTO(call), inviteUrl: inviteURL(call), episodes, live, nextCursor: start + 7 < own.length ? String(start + 7) : null, knocks: data.knocks ?? [] });
    }
    if (page === "past-session") {
      const episode = data.sessions.find((item) => item.id === query.episodeId);
      if (!episode || query.spaceId !== data.calls[0]?.id) return fail(response, 404, "not_found");
      const offsets = [0, 0, 1, 3, 7, 9];
      const length = (Date.parse(episode.endedAt) - Date.parse(episode.startedAt)) / 60000;
      const participants = episode.people.map((name, i) => ({
        id: uuid(0x700 + i),
        name,
        // The server marks only the owner's current seat: here, Hasan in the newest session.
        isYou: name === "Hasan Shoaib" && episode === data.sessions[0],
        kind: name === "Malik Haddad" ? "guest" : "user",
        externalId: name === "Malik Haddad" ? null : `user_${i}`,
        firstJoinedAt: plus(episode.startedAt, offsets[i] ?? i * 2),
        lastLeftAt: i === 3 ? plus(episode.startedAt, length - 7) : null,
      }));
      // Like the server, a past session lists each recording's transcripts.
      const recordings = recordingsFor(episode, false).map((recording) => ({ ...recording, transcripts: transcriptsFor(episode.endedAt) }));
      return send(response, 200, { callName: data.calls[0].name, episode: episodeDTO(episode), attendance: { kind: "available", participants }, recordings, nextCursor: null });
    }
    if (page === "developer")
      return send(response, 200, {
        recordingRenderMode: data.recordingRenderMode ?? "on_demand",
        allowedWebsites: data.origins,
        keys: data.keys.filter((key) => !key.revokedAt),
        webhooks: data.webhooks.map((webhook) => ({ ...webhook, lastDelivery: data.deliveries[webhook.id]?.[0] ?? null })),
        nextKeyCursor: null,
        nextWebhookCursor: null,
      });
    return fail(response, 404, "route_not_found");
  }
  const action = await readBody(request);
  entry.body = action;
  if (state.limit.has(action.action)) return fail(response, 429, "engine_rate_limited", { retryable: true, retryAfterSeconds: 60 });
  if (state.fail.has(action.action)) return fail(response, 503, "service_unavailable");
  if (state.freshSignIn.has(action.action)) return fail(response, 401, "fresh_sign_in_required");
  await wait(250);
  const call = data.calls.find((item) => item.id === action.spaceId);
  switch (action.action) {
    case "create-call": {
      const created = { id: uuid(0x1000 + data.calls.length), slug: `call-${action.idempotencyKey}`, name: action.name ?? "New call", archived: false, admission: action.admission, createdAt: new Date().toISOString() };
      data.calls.unshift(created);
      return send(response, 200, { call: callDTO(created) });
    }
    case "rename-call":
      call.name = action.name;
      return send(response, 200, { call: callDTO(call) });
    case "set-admission":
      call.admission = action.admission;
      return send(response, 200, { call: callDTO(call) });
    case "approve-knock":
    case "deny-knock":
      data.knocks = data.knocks.filter((knock) => knock.handle !== action.requestHandle);
      return send(response, 200, { ok: true });
    case "archive-call":
    case "restore-call":
      call.archived = action.action === "archive-call";
      return send(response, 200, { call: callDTO(call) });
    case "join":
    case "refresh-access":
      return fail(response, 503, "fixture_has_no_engine");
    case "recording-url":
      return send(response, 200, { url: `${ORIGIN}/__fixture/video.mp4`, expiresAt: plus(new Date().toISOString(), 5), method: "GET", headers: {} });
    case "export-recording":
      state.recordingScenario = "export_pending";
      return send(response, 200, { recording: recordingsFor(data.sessions[0], false)[0] });
    case "transcripts":
      if (state.recordingScenario === "missing") return fail(response, 404, "recording_not_found");
      return send(response, 200, { transcripts: transcriptsFor(new Date().toISOString()) });
    case "create-transcript":
      if (state.transcript !== "none") return fail(response, 409, "transcript_already_exists");
      state.transcript = "processing";
      return send(response, 200, { transcript: transcriptsFor(new Date().toISOString())[0] });
    case "transcript-document":
      return send(response, 200, { cues: TRANSCRIPT.map(([seconds, name, text]) => ({ startMs: seconds * 1000, endMs: seconds * 1000 + 5000, text, speaker: { name, participantRef: SEAT(name) } })) });
    case "transcript-url":
      return send(response, 200, { url: `${ORIGIN}/__fixture/transcript.txt`, expiresAt: plus(new Date().toISOString(), 5), method: "GET", headers: {} });
    case "set-recording-render-mode":
      data.recordingRenderMode = action.mode;
      return send(response, 200, { recordingRenderMode: data.recordingRenderMode });
    case "set-allowed-websites":
      data.origins = [...new Set(["https://chalkmeet.com", ...action.origins])];
      return send(response, 200, { allowedWebsites: data.origins });
    case "create-key": {
      const id = uuid(0x3000 + data.keys.length);
      data.keys.unshift({ id, name: action.name, prefix: "chalk_sk_Rw8f", scopes: action.scopes, expiresAt: action.expiresAt, revokedAt: null, lastUsedAt: null });
      return send(response, 200, { id, secret: "chalk_sk_Rw8f2LqN0vXc4TzJ7hKp1sYd9mBaE3uG" });
    }
    case "rotate-key":
      return send(response, 200, { id: action.keyId, secret: "chalk_sk_Pq3m8VtL1wXn6RzK2hJc9yBd4sFaG7eU" });
    case "revoke-key":
      data.keys.find((key) => key.id === action.keyId).revokedAt = new Date().toISOString();
      return send(response, 200, { ok: true });
    case "create-webhook": {
      const webhook = { id: uuid(0x4000 + data.webhooks.length), name: action.name, url: `${new URL(action.url).origin}/…`, enabled: true, revision: 1, eventTypes: action.eventTypes };
      data.webhooks.push(webhook);
      data.deliveries[webhook.id] = [];
      return send(response, 200, { webhook, secret: "whsec_Rw8f2LqN0vXc4TzJ7hKp1sYd9mBaE3uG" });
    }
    case "update-webhook": {
      const webhook = data.webhooks.find((item) => item.id === action.webhookId);
      if (!webhook) return fail(response, 404, "not_found");
      if (webhook.revision !== action.revision) return fail(response, 409, "revision_conflict");
      Object.assign(webhook, {
        ...(action.name ? { name: action.name } : {}),
        ...(action.url ? { url: `${new URL(action.url).origin}/…` } : {}),
        ...(action.enabled === undefined ? {} : { enabled: action.enabled }),
        ...(action.eventTypes ? { eventTypes: action.eventTypes } : {}),
        revision: webhook.revision + 1,
      });
      return send(response, 200, { webhook });
    }
    case "rotate-webhook-secret":
      return send(response, 200, { id: action.webhookId, secret: "whsec_Tn5k2LqN0vXc4TzJ7hKp1sYd9mBaE3uG" });
    case "test-webhook": {
      const id = uuid(0x5000 + log.length);
      data.deliveries[action.webhookId].unshift({ id, state: "pending", createdAt: new Date().toISOString(), eventType: "test", attempts: 0, status: null });
      return send(response, 200, { deliveryId: id });
    }
    case "webhook-deliveries":
      return send(response, 200, { deliveries: data.deliveries[action.webhookId] ?? [], nextCursor: null });
    case "redeliver-webhook": {
      const delivery = data.deliveries[action.webhookId].find((item) => item.id === action.deliveryId);
      delivery.state = "pending";
      return send(response, 200, { deliveryId: delivery.id });
    }
    default:
      return fail(response, 400, "invalid_request");
  }
}

function proxy(request, response) {
  const upstream = httpRequest({ host: VITE.hostname, port: VITE.port, path: request.url, method: request.method, headers: { ...request.headers, host: VITE.host } }, (reply) => {
    response.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(response);
  });
  upstream.on("error", () => response.writeHead(502).end("Vite is not running"));
  request.pipe(upstream);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", ORIGIN);
  const path = url.pathname;
  try {
    if (path.startsWith("/__fixture/")) {
      if (path === "/__fixture/log") return send(response, 200, log);
      if (path === "/__fixture/reset") {
        reset();
        return send(response, 200, { ok: true });
      }
      if (path === "/__fixture/video.mp4" && existsSync(VIDEO)) {
        // Byte ranges, as signed storage URLs serve them, so the player can seek.
        const video = readFileSync(VIDEO);
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        if (!range) {
          response.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": video.length });
          return response.end(video);
        }
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
        response.writeHead(206, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${video.length}`, "Content-Length": end - start + 1 });
        return response.end(video.subarray(start, end + 1));
      }
      if (path === "/__fixture/transcript.txt") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        return response.end(TRANSCRIPT.map(([, name, text]) => `${name}: ${text}`).join("\n"));
      }
      if (path === "/__fixture/set") {
        for (const [key, value] of url.searchParams) {
          if (key === "account") state.account = value;
          else if (key === "delay") {
            const delay = Number(value);
            if (!/^\d+$/.test(value) || !Number.isFinite(delay) || !Number.isInteger(delay) || delay < 0 || delay > MAX_FIXTURE_DELAY_MS) return fail(response, 400, "invalid_delay");
            state.delay = Math.min(delay, MAX_FIXTURE_DELAY_MS);
          } else if (key === "fail" || key === "limit" || key === "freshSignIn") state[key] = new Set(value ? value.split(",") : []);
          else if (key === "expire") state.expire = value === "1";
          else if (key === "live") accounts.hasan.live = value === "1";
          else if (key === "freshLive") {
            accounts.hasan.live = true;
            accounts.hasan.sessions = [];
          } else if (key === "ending") {
            accounts.hasan.live = false;
            accounts.hasan.sessions = [{ id: uuid(0x2ff), status: "ending", startedAt: at(0, 10, 2), endedAt: null, people: ["Nora Patel"], kept: "none" }];
          } else if (key === "end") {
            accounts.hasan.live = false;
            accounts.hasan.sessions = accounts.hasan.sessions.filter((episode) => episode.id !== uuid(0x2ff));
            accounts.hasan.sessions.unshift({ id: uuid(0x2ff), status: "ended", startedAt: at(0, 10, 2), endedAt: at(0, 10, 9), people: ["Nora Patel"], kept: "recording" });
          } else if (key === "knocks") accounts.hasan.knocks = value === "1" ? [{ handle: "sample-knock", name: "Sample guest", state: "pending", requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }] : [];
          else if (key === "liveParticipants") {
            if (!["0", "1", "3"].includes(value)) return fail(response, 400, "invalid_participant_count");
            state.liveParticipantCount = Number(value);
          } else if (key === "metadataDiscovery") {
            accounts.hasan.live = false;
            accounts.hasan.calls[0].admission = "anyone";
            accounts.hasan.sessions = [{ ...accounts.hasan.sessions[0], kept: "done" }];
            state.hideTranscripts = value === "pending";
            state.transcriptionPending = value === "pending";
            state.finishedTranscript = "complete";
          } else if (key === "admission") {
            if (!["anyone", "knock"].includes(value)) return fail(response, 400, "invalid_admission");
            accounts.hasan.calls[0].admission = value;
          } else if (key === "metadataComplete") {
            for (const session of accounts.hasan.sessions) if (session.kept === "processing") session.kept = "done";
            state.finishedTranscript = value;
          } else if (key === "recordingScenario") {
            state.recordingScenario = value;
            state.transcript = ["available", "export_pending", "export_ready", "export_failed", "export_exhausted"].includes(value) ? "complete" : value === "transcript_failed" ? "terminal_failure" : "none";
            accounts.hasan.live = false;
            accounts.hasan.calls[0].admission = "anyone";
          } else if (key === "expireIn") state.expireAt = Date.now() + Number(value) * 1000;
          else if (key === "transcript") state.transcript = value;
          else if (key === "signInError") state.signInError = value === "1";
          else if (key === "newCall") accounts.hasan.calls.unshift({ id: uuid(0x1000 + accounts.hasan.calls.length), slug: "made-elsewhere", name: value, archived: false, admission: "knock", createdAt: new Date().toISOString() });
        }
        return send(response, 200, { ok: true });
      }
      return fail(response, 404, "route_not_found");
    }
    if (path.startsWith("/auth/") || path.startsWith("/dashboard-api/")) {
      const entry = { method: request.method, path, query: url.search, csrf: request.headers["x-csrf-token"] ?? null, origin: request.headers.origin ?? null };
      log.push(entry);
      if (path.startsWith("/auth/")) return await auth(request, response, path, url);
      return await dashboard(request, response, path.slice("/dashboard-api/".length), url, entry);
    }
    proxy(request, response);
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      response.setHeader("Connection", "close");
      fail(response, 413, "body_too_large");
      return;
    }
    console.error(error);
    fail(response, 500, "fixture_error");
  }
});
server.on("upgrade", (request, socket, head) => {
  const upstream = connect(Number(VITE.port), VITE.hostname, () => {
    upstream.write(
      `${request.method} ${request.url} HTTP/1.1\r\n${Object.entries({ ...request.headers, host: VITE.host })
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n")}\r\n\r\n`,
    );
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
server.listen(PORT, "127.0.0.1", () => console.log(`dashboard fixture on ${ORIGIN}, proxying ${VITE.origin}`));
