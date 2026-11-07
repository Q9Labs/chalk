// Fixture responses for the signed-in dashboard, so its screens can be shot without an API or a database.
// The shapes follow apps/web/src/lib/dashboard/contracts.ts.

const day = "2026-10-21T09:30:00Z";
const callId = "00000000-0000-4000-8000-0000000000c1";
const episodeId = "00000000-0000-4000-8000-0000000000e1";
const liveEpisodeId = "00000000-0000-4000-8000-0000000000e2";

const call = (id, name, extra = {}) => ({ id, name, slug: name.toLowerCase().replaceAll(" ", "-"), admission: "knock", archived: false, createdAt: day, transcriptLanguage: null, ...extra });
const people = [
  { id: "p1", name: "Amira Khan" },
  { id: "p2", name: "Jonas Weber" },
  { id: "p3", name: "Priya Nair" },
];
const recording = (id, extra = {}) => ({
  id,
  status: "completed",
  sourceStatus: "available",
  sourceExpiresAt: null,
  exportStatus: "ready",
  exportRetryable: false,
  failureMessage: null,
  transcriptionStatus: "ready",
  transcriptionExpiresAt: null,
  createdAt: day,
  transcripts: [{ id: "t1", status: "complete", languages: ["en"], createdAt: day }],
  ...extra,
});
const homeCalls = [
  { ...call(callId, "Weekly sync"), inviteUrl: "https://chalk.test/join/weekly", lastActiveAt: day, recentPeople: people },
  { ...call("00000000-0000-4000-8000-0000000000c2", "Design review", { admission: "anyone" }), inviteUrl: "https://chalk.test/join/design", lastActiveAt: day, recentPeople: people.slice(0, 2) },
  { ...call("00000000-0000-4000-8000-0000000000c3", "Customer interview"), inviteUrl: "https://chalk.test/join/interview", lastActiveAt: null, recentPeople: [] },
  { ...call("00000000-0000-4000-8000-0000000000c4", "Old standup", { archived: true }), inviteUrl: null, lastActiveAt: day, recentPeople: people.slice(0, 1) },
];
const live = [{ spaceId: callId, episode: { id: liveEpisodeId, count: 2, participants: people.slice(0, 2) } }];
const knocks = [{ handle: "k1", name: "Sam Rivera", requestedAt: day, expiresAt: "2026-10-21T10:30:00Z", state: "pending", decisionState: "none", decisionAction: null }];

const pages = {
  connections: () => ({ connections: [], nextCursor: null }),
  home: () => ({ calls: homeCalls, live, nextCursor: null }),
  "home-status": () => ({ live, calls: homeCalls.map(({ id, archived, lastActiveAt, recentPeople }) => ({ id, archived, lastActiveAt, recentPeople })) }),
  call: () => ({
    call: call(callId, "Weekly sync"),
    inviteUrl: "https://chalk.test/join/weekly",
    episodes: [
      { id: liveEpisodeId, status: "active", startedAt: day, endedAt: null, participantCount: 2, recordings: [], recordingsNextCursor: null },
      { id: episodeId, status: "ended", startedAt: day, endedAt: "2026-10-21T10:10:00Z", participantCount: 3, recordings: [recording("r1")], recordingsNextCursor: null },
    ],
    live: live[0].episode,
    nextCursor: null,
    knocks,
  }),
  "call-status": () => ({ latestEpisodeId: liveEpisodeId, episode: { id: liveEpisodeId, status: "active" }, knocks }),
  "call-invite": () => ({ inviteUrl: "https://chalk.test/join/weekly" }),
  "past-session": () => ({
    callName: "Weekly sync",
    episode: { id: episodeId, status: "ended", startedAt: day, endedAt: "2026-10-21T10:10:00Z" },
    attendance: {
      kind: "available",
      participants: people.map((person, index) => ({ ...person, kind: "user", externalId: null, isYou: index === 0, firstJoinedAt: day, lastLeftAt: "2026-10-21T10:10:00Z" })),
    },
    recordings: [recording("r1"), recording("r2", { createdAt: "2026-10-20T09:00:00Z", sourceStatus: "expired", transcriptionStatus: "expired", transcripts: [] })],
    nextCursor: null,
  }),
  "call-metadata": () => ({ kind: "recording", recording: recording("r1") }),
  developer: () => ({
    tenantId: "00000000-0000-4000-8000-000000000001",
    recordingRenderMode: "on_demand",
    allowedWebsites: ["https://app.example.com", "https://staging.example.com"],
    keys: [
      { id: "k1", name: "Production", prefix: "ck_live_ab12", scopes: ["calls"], expiresAt: "2027-10-21T00:00:00Z", revokedAt: null, lastUsedAt: day },
      { id: "k2", name: "Staging", prefix: "ck_test_cd34", scopes: ["calls"], expiresAt: "2027-10-21T00:00:00Z", revokedAt: null, lastUsedAt: null },
      { id: "k3", name: "Old key", prefix: "ck_live_ef56", scopes: ["calls"], expiresAt: "2026-09-01T00:00:00Z", revokedAt: day, lastUsedAt: day },
    ],
    webhooks: [
      { id: "w1", name: "Billing", url: "https://api.example.com/hooks/chalk", enabled: true, revision: 1, eventTypes: ["episode.ended", "recording.ready"], lastDelivery: { id: "d1", state: "delivered", createdAt: day, eventType: "episode.ended", attempts: 1, status: 200 } },
      { id: "w2", name: "Audit log", url: "https://audit.example.com/chalk", enabled: false, revision: 2, eventTypes: ["episode.started"], lastDelivery: null },
    ],
    nextKeyCursor: null,
    nextWebhookCursor: null,
  }),
};

const cues = [
  { startMs: 0, endMs: 4000, text: "Thanks for joining. Let's start with the roadmap.", speaker: "Amira Khan" },
  { startMs: 4000, endMs: 9000, text: "The recorder ships next week, and the transcript follows it.", speaker: "Noor Ali" },
  { startMs: 9000, endMs: 13000, text: "Good. I will send the notes after the call.", speaker: "Amira Khan" },
];

export const DASHBOARD_PATHS = ["/dashboard", `/dashboard/call/${callId}`, `/dashboard/call/${callId}/session/${episodeId}`, "/dashboard/developer"];

export async function installDashboardStubs(context) {
  await context.route("**/auth/session", (route) => route.fulfill({ json: { profile: { id: "u1", name: "Amira Khan", email: "amira@example.com", avatarUrl: null }, csrfToken: "fixture-csrf" } }));
  await context.route("**/dashboard-api/**", (route) => {
    const page = new URL(route.request().url()).pathname.split("/").at(-1);
    // The past-session page loads its transcript with a POST action; the GET payload has no cues.
    if (route.request().postDataJSON()?.action === "transcript-document") return route.fulfill({ json: { cues } });
    const build = pages[page];
    return build ? route.fulfill({ json: build() }) : route.fulfill({ status: 503, json: { error: { code: "engine_unavailable" } } });
  });
}
