"use strict";
/* chalk · API design draft board — model, render, OpenAPI export, lint */
const $ = (s, r = document) => r.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const STORE = "chalk.api.design.v2";
const SCALARS = ["string", "text", "uuid", "integer", "number", "boolean", "timestamptz", "inet", "url", "enum", "jsonb"];
const TYPES = [...SCALARS, "object", "array", "$ref"];
const ARRAY_OF = ["string", "uuid", "integer", "number", "boolean", "timestamptz", "object", "$ref"];
const PARAM_TYPES = ["string", "uuid", "integer", "number", "boolean", "timestamptz", "enum"];
const FORMATS = ["application/json", "multipart/form-data", "application/x-www-form-urlencoded", "none"];
const AUTHS = ["API key", "Bearer (user)", "Public"];
let uid = 0; const nid = p => p + "_" + (++uid).toString(36);
const splitEnum = s => (s || "").split("|").map(x => x.trim()).filter(Boolean);

/* ---------- seed (shorthand) ---------- */
const J = o => JSON.stringify(o, null, 2);
const E = (code, message, field) => J({ error: field ? { code, message, field } : { code, message } });
const ts = "2026-06-26T09:30:00Z";
const idem = { in: "header", n: "Idempotency-Key", t: "uuid", r: false, d: "Unique key to make a create safe to retry." };
const F = (n, t, r, d, x) => ({ n, t, r, d, ...x }); // field shorthand helper

const COMPONENTS = [
  { n: "Error", d: "Standard error envelope returned by every 4xx/5xx response.", f: [
    F("error", "object", true, "Error details.", { ch: [
      F("code", "string", true, "Stable, machine-readable error code."),
      F("message", "string", true, "Human-readable explanation."),
      F("field", "string", false, "Offending field, when the error is a validation failure.") ] }) ] },
  { n: "Tenant", d: "A workspace — the root boundary for every other resource.", f: [
    F("id", "uuid", true, "Tenant id."), F("name", "string", true, "Display name."),
    F("default_region", "string", false, "Preferred edge region."),
    F("default_media_plane", "enum", false, "Media transport for new rooms.", { e: "cf_sfu | cf_rtk | mediasoup" }),
    F("website", "url", false, "Public website."), F("created_at", "timestamptz", true, "Creation time."),
    F("updated_at", "timestamptz", true, "Last update time.") ] },
  { n: "Room", d: "A durable meeting space.", f: [
    F("id", "uuid", true, "Room id."), F("tenant_id", "uuid", true, "Owning tenant."),
    F("name", "string", true, "Display name."), F("slug", "string", true, "URL slug, unique per tenant."),
    F("status", "enum", true, "Lifecycle status.", { e: "active | archived" }),
    F("media_plane", "enum", true, "Media transport.", { e: "cf_sfu | cf_rtk | mediasoup" }),
    F("metadata", "jsonb", false, "Arbitrary key/value data."),
    F("recurring_policy", "object", false, "RRULE schedule, or null for one-off rooms.", { ch: [
      F("timezone", "string", true, "IANA timezone, e.g. Asia/Dubai."),
      F("dtstart", "string", true, "Local start datetime."),
      F("rrule", "string", true, "RFC 5545 recurrence rule.") ] }),
    F("created_at", "timestamptz", true, "Creation time.") ] },
  { n: "Session", d: "A single live occurrence inside a room.", f: [
    F("id", "uuid", true, "Session id."), F("room_id", "uuid", true, "Parent room."),
    F("status", "enum", true, "Status.", { e: "active | ended" }),
    F("started_at", "timestamptz", false, "When it went live."),
    F("ended_at", "timestamptz", false, "When it closed.") ] },
  { n: "Participant", d: "Someone present in a session.", f: [
    F("id", "uuid", true, "Participant id."), F("session_id", "uuid", true, "Session."),
    F("name", "string", false, "Display name."),
    F("capabilities", "array", true, "Granted capabilities.", { of: "string" }),
    F("user_id", "uuid", false, "Linked user, if any."),
    F("metadata", "jsonb", false, "Arbitrary data.") ] },
  { n: "Recording", d: "A capture of a session in object storage.", f: [
    F("id", "uuid", true, "Recording id."), F("session_id", "uuid", true, "Session."),
    F("status", "enum", true, "Status.", { e: "pending | processing | completed | failed" }),
    F("storage_provider", "enum", true, "Where the file lives.", { e: "s3 | cf | do" }),
    F("storage_key", "string", false, "Object key once complete."),
    F("created_at", "timestamptz", true, "Creation time.") ] },
  { n: "Transcription", d: "Text derived from a completed recording.", f: [
    F("id", "uuid", true, "Transcription id."), F("recording_id", "uuid", true, "Source recording."),
    F("status", "enum", true, "Status.", { e: "pending | processing | completed | failed" }),
    F("provider", "enum", true, "Provider.", { e: "cf | openrouter | openai | groq" }),
    F("model", "string", true, "Provider model id."),
    F("languages", "array", true, "Expected languages (BCP-47).", { of: "string" }),
    F("text", "string", false, "Transcript, once completed."),
    F("completed_at", "timestamptz", false, "Completion time.") ] }
];

const PAGE = [{ in: "query", n: "limit", t: "integer", r: false, d: "Page size, 1–100. Default 20." },
              { in: "query", n: "cursor", t: "string", r: false, d: "Opaque cursor from a previous page." }];

const SEED = { meta: {
    name: "Chalk API", baseUrl: "https://api.chalk.dev", version: "v1",
    description: "Draft design board for the Chalk HTTP API — tenants, rooms, real-time sessions, participant tokens, recordings and transcriptions. The implemented API remains the source of truth." },
  components: COMPONENTS,
  categories: [
  { n: "Tenants", d: "Workspaces — the root every other resource hangs off.", e: [
    { m: "POST", p: "/v1/tenants", a: "API key", bf: "application/json", s: "Create a tenant",
      d: "Provision a new workspace. Defaults here apply to rooms created under the tenant.",
      prm: [idem],
      f: [F("name", "string", true, "Display name."), F("default_region", "string", false, "Preferred edge region."),
          F("default_media_plane", "enum", false, "Media transport for new rooms.", { e: "cf_sfu | cf_rtk | mediasoup" }),
          F("website", "url", false, "Public website URL.")],
      r: [{ s: 201, l: "Created", d: "The tenant.", ref: "Tenant", j: J({ id: "7c1f…a9", name: "Lumen Labs", default_media_plane: "cf_sfu", created_at: ts }) },
          { s: 400, l: "Bad request", d: "Validation failed.", ref: "Error", j: E("invalid_request", "name is required", "name") },
          { s: 401, l: "Unauthorized", d: "Missing or invalid API key.", ref: "Error", j: E("unauthorized", "API key required") }] },
    { m: "GET", p: "/v1/tenants/{id}", a: "API key", bf: "none", s: "Get a tenant", d: "Fetch a single tenant by id.",
      r: [{ s: 200, l: "OK", d: "The tenant.", ref: "Tenant", j: J({ id: "7c1f…a9", name: "Lumen Labs", created_at: ts }) },
          { s: 404, l: "Not found", d: "No tenant with that id.", ref: "Error", j: E("not_found", "tenant not found") }] },
    { m: "PATCH", p: "/v1/tenants/{id}", a: "API key", bf: "application/json", s: "Update a tenant", d: "Update one or more fields. All optional.",
      f: [F("name", "string", false, "New display name."),
          F("default_media_plane", "enum", false, "New default media plane.", { e: "cf_sfu | cf_rtk | mediasoup" }),
          F("website", "url", false, "New website URL.")],
      r: [{ s: 200, l: "OK", d: "The updated tenant.", ref: "Tenant", j: J({ id: "7c1f…a9", default_media_plane: "cf_rtk", updated_at: ts }) }] },
    { m: "GET", p: "/v1/tenants", a: "API key", bf: "none", s: "List tenants", d: "List tenants visible to the caller.",
      prm: PAGE,
      r: [{ s: 200, l: "OK", d: "A page of tenants.", j: J({ data: [{ id: "7c1f…a9", name: "Lumen Labs" }], next_cursor: null }) }] } ] },

  { n: "Auth", d: "Sign in, refresh, and manage device sessions.", e: [
    { m: "POST", p: "/v1/auth/register", a: "Public", bf: "application/json", s: "Register with password", d: "Create a user and password identity, returning a session.",
      f: [F("name", "string", true, "Full name."), F("email", "string", true, "Email address."),
          F("password", "string", true, "Plaintext password, hashed server-side. Min 10 chars.")],
      r: [{ s: 201, l: "Created", d: "User created and signed in.", j: J({ user: { id: "u_18b…", email: "mara@lumen.io" }, session: { token: "sess_live_…", expires_at: ts } }) }] },
    { m: "POST", p: "/v1/auth/login", a: "Public", bf: "application/json", s: "Sign in", d: "Exchange email + password for a session token.",
      f: [F("email", "string", true, "Email address."), F("password", "string", true, "Account password."),
          F("device_name", "string", false, "Label shown in the session list.")],
      r: [{ s: 200, l: "OK", d: "Signed in.", j: J({ session: { token: "sess_live_…", expires_at: ts } }) },
          { s: 401, l: "Unauthorized", d: "Wrong email or password.", ref: "Error", j: E("invalid_credentials", "email or password is incorrect") }] },
    { m: "GET", p: "/v1/auth/sessions", a: "Bearer (user)", bf: "none", s: "List devices", d: "List the signed-in user's active sessions.",
      r: [{ s: 200, l: "OK", d: "The sessions.", j: J({ data: [{ id: "ls_9…", device_name: "MacBook Pro", ip_address: "203.0.113.4", created_at: ts }] }) }] },
    { m: "DELETE", p: "/v1/auth/sessions/{id}", a: "Bearer (user)", bf: "none", s: "Revoke a device", d: "Revoke a specific session by id.",
      r: [{ s: 204, l: "No content", d: "The session was revoked.", j: "" },
          { s: 404, l: "Not found", d: "No such session.", ref: "Error", j: E("not_found", "session not found") }] } ] },

  { n: "Access keys", d: "API keys and tenant signing keys.", e: [
    { m: "POST", p: "/v1/tenants/{tenantId}/api-keys", a: "API key", bf: "application/json", s: "Create an API key", d: "Mint a tenant-scoped key. The secret is returned only once.",
      f: [F("name", "string", true, "Human label."),
          F("scopes", "array", true, "Permitted scopes, e.g. rooms:write.", { of: "string" }),
          F("expires_at", "timestamptz", false, "Optional expiry.")],
      r: [{ s: 201, l: "Created", d: "Store the key now — not retrievable again.", j: J({ id: "ak_2f…", name: "Backend", key_prefix: "ck_live_2f", key: "ck_live_2f8b…<once>", scopes: ["rooms:write"], created_at: ts }) }] },
    { m: "POST", p: "/v1/tenants/{tenantId}/signing-keys", a: "API key", bf: "application/json", s: "Register a signing key", d: "Register a tenant public key (EdDSA / Ed25519) used to verify participant tokens.",
      f: [F("key_id", "string", true, "Unique kid referenced by tokens."),
          F("algorithm", "enum", true, "Signature algorithm.", { e: "EdDSA" }),
          F("public_key_jwk", "object", true, "Public key as a JWK.", { ch: [
            F("kty", "string", true, "Key type, e.g. OKP."),
            F("crv", "string", true, "Curve, e.g. Ed25519."),
            F("x", "string", true, "Base64url public key.") ] }),
          F("expires_at", "timestamptz", true, "When this key stops being trusted.")],
      r: [{ s: 201, l: "Created", d: "The registered key.", j: J({ id: "sk_7…", key_id: "2026-06", algorithm: "EdDSA", expires_at: ts }) }] },
    { m: "DELETE", p: "/v1/api-keys/{id}", a: "API key", bf: "none", s: "Revoke an API key", d: "Immediately revoke a key.",
      r: [{ s: 204, l: "No content", d: "The key was revoked.", j: "" }] } ] },

  { n: "Rooms", d: "Durable meeting spaces; each hosts many sessions.", e: [
    { m: "POST", p: "/v1/rooms", a: "API key", bf: "application/json", s: "Create a room", d: "Create a room. Omit media_plane to inherit the tenant default.",
      prm: [idem],
      f: [F("name", "string", true, "Display name."),
          F("slug", "string", false, "URL slug, unique per tenant. Auto-generated if omitted."),
          F("media_plane", "enum", false, "Media transport.", { e: "cf_sfu | cf_rtk | mediasoup" }),
          F("metadata", "jsonb", false, "Arbitrary key/value data echoed back."),
          F("recurring_policy", "object", false, "RRULE schedule. Null for one-off rooms.", { ch: [
            F("timezone", "string", true, "IANA timezone, e.g. Asia/Dubai."),
            F("dtstart", "string", true, "Local start datetime."),
            F("rrule", "string", true, "RFC 5545 recurrence rule.") ] })],
      r: [{ s: 201, l: "Created", d: "The room.", ref: "Room", j: J({ id: "rm_5d…", name: "Weekly Standup", slug: "weekly-standup", status: "active", media_plane: "cf_sfu", created_at: ts }) },
          { s: 409, l: "Conflict", d: "Slug already taken for this tenant.", ref: "Error", j: E("conflict", "slug already in use", "slug") }] },
    { m: "GET", p: "/v1/rooms", a: "API key", bf: "none", s: "List rooms", d: "List rooms for the tenant. Filter by status or search.",
      prm: [{ in: "query", n: "status", t: "enum", r: false, d: "Filter by room status.", e: "active | archived" },
            { in: "query", n: "q", t: "string", r: false, d: "Search by name or slug." }, ...PAGE],
      r: [{ s: 200, l: "OK", d: "A page of rooms.", j: J({ data: [{ id: "rm_5d…", name: "Weekly Standup", status: "active" }], next_cursor: null }) }] },
    { m: "GET", p: "/v1/rooms/{id}", a: "API key", bf: "none", s: "Get a room", d: "Fetch a single room by id.",
      r: [{ s: 200, l: "OK", d: "The room.", ref: "Room", j: J({ id: "rm_5d…", name: "Weekly Standup", status: "active", media_plane: "cf_sfu", created_at: ts }) }] },
    { m: "PATCH", p: "/v1/rooms/{id}", a: "API key", bf: "application/json", s: "Update a room", d: "Update room fields. Set status to archived to retire it.",
      f: [F("name", "string", false, "New name."), F("status", "enum", false, "Lifecycle status.", { e: "active | archived" }),
          F("metadata", "jsonb", false, "Replace metadata.")],
      r: [{ s: 200, l: "OK", d: "The updated room.", ref: "Room", j: J({ id: "rm_5d…", status: "archived" }) }] },
    { m: "DELETE", p: "/v1/rooms/{id}", a: "API key", bf: "none", s: "Delete a room", d: "Permanently delete a room and its sessions.",
      r: [{ s: 204, l: "No content", d: "The room was deleted.", j: "" }] } ] },

  { n: "Sessions", d: "Live occurrences inside a room — start, read, end.", e: [
    { m: "POST", p: "/v1/rooms/{roomId}/sessions", a: "API key", bf: "application/json", s: "Start a session", d: "Open a live session in a room.",
      prm: [idem], f: [F("metadata", "jsonb", false, "Arbitrary data attached to the session.")],
      r: [{ s: 201, l: "Created", d: "The session is live.", ref: "Session", j: J({ id: "ses_aa…", room_id: "rm_5d…", status: "active", started_at: ts }) }] },
    { m: "GET", p: "/v1/sessions/{id}", a: "API key", bf: "none", s: "Get a session", d: "Fetch a session, including timing and status.",
      r: [{ s: 200, l: "OK", d: "The session.", ref: "Session", j: J({ id: "ses_aa…", room_id: "rm_5d…", status: "active", started_at: ts }) }] },
    { m: "POST", p: "/v1/sessions/{id}/end", a: "API key", bf: "none", s: "End a session", d: "Close the live session and disconnect participants.",
      r: [{ s: 200, l: "OK", d: "The ended session.", ref: "Session", j: J({ id: "ses_aa…", status: "ended", ended_at: ts }) }] } ] },

  { n: "Participants", d: "Mint join tokens and read who is in a session.", e: [
    { m: "POST", p: "/v1/rooms/{roomId}/tokens", a: "API key", bf: "application/json", s: "Mint a participant token", d: "Issue a short-lived EdDSA-signed JWT a client uses to join.",
      f: [F("identity", "string", true, "Stable participant identity."),
          F("name", "string", false, "Display name shown to others."),
          F("capabilities", "array", true, "Granted capabilities, e.g. publish, subscribe.", { of: "string" }),
          F("ttl_seconds", "integer", false, "Token lifetime. Default 900."),
          F("metadata", "jsonb", false, "Data embedded in the token.")],
      r: [{ s: 201, l: "Created", d: "The join token.", j: J({ token: "eyJhbGciOiJFZERTQ…", expires_at: ts, capabilities: ["publish", "subscribe"] }) }] },
    { m: "GET", p: "/v1/sessions/{sessionId}/participants", a: "API key", bf: "none", s: "List participants", d: "List everyone currently in a session.",
      r: [{ s: 200, l: "OK", d: "The participants.", j: J({ data: [{ id: "par_3…", name: "Mara", capabilities: ["publish", "subscribe"] }] }) }] },
    { m: "GET", p: "/v1/participants/{id}", a: "API key", bf: "none", s: "Get a participant", d: "Fetch a single participant by id.",
      r: [{ s: 200, l: "OK", d: "The participant.", ref: "Participant", j: J({ id: "par_3…", session_id: "ses_aa…", name: "Mara", capabilities: ["publish", "subscribe"] }) }] } ] },

  { n: "Recordings", d: "Capture a session and track its status.", e: [
    { m: "POST", p: "/v1/sessions/{sessionId}/recordings", a: "API key", bf: "application/json", s: "Start a recording", d: "Begin recording a live session. Processing is async.",
      f: [F("storage_provider", "enum", true, "Where the file is written.", { e: "s3 | cf | do" }),
          F("metadata", "jsonb", false, "Arbitrary data.")],
      r: [{ s: 201, l: "Created", d: "Recording started.", ref: "Recording", j: J({ id: "rec_6…", session_id: "ses_aa…", status: "processing", storage_provider: "s3", created_at: ts }) }] },
    { m: "GET", p: "/v1/recordings/{id}", a: "API key", bf: "none", s: "Get a recording", d: "Fetch a recording, including its storage key once complete.",
      r: [{ s: 200, l: "OK", d: "The recording.", ref: "Recording", j: J({ id: "rec_6…", status: "completed", storage_provider: "s3", storage_key: "rec/2026/06/rec_6.mp4" }) }] },
    { m: "GET", p: "/v1/recordings", a: "API key", bf: "none", s: "List recordings", d: "List recordings for the tenant, newest first.",
      prm: [{ in: "query", n: "status", t: "enum", r: false, d: "Filter by status.", e: "pending | processing | completed | failed" },
            { in: "query", n: "room_id", t: "uuid", r: false, d: "Only recordings for this room." }, ...PAGE],
      r: [{ s: 200, l: "OK", d: "The recordings.", j: J({ data: [{ id: "rec_6…", status: "completed" }], next_cursor: null }) }] } ] },

  { n: "Transcriptions", d: "Turn a finished recording into searchable text.", e: [
    { m: "POST", p: "/v1/recordings/{recordingId}/transcriptions", a: "API key", bf: "application/json", s: "Start a transcription", d: "Queue a transcription for a completed recording.",
      f: [F("provider", "enum", true, "Provider.", { e: "cf | openrouter | openai | groq" }),
          F("model", "string", true, "Provider model id, e.g. whisper-large-v3."),
          F("languages", "array", true, "Expected languages (BCP-47).", { of: "string" })],
      r: [{ s: 201, l: "Created", d: "Transcription queued.", ref: "Transcription", j: J({ id: "tr_8…", recording_id: "rec_6…", status: "pending", provider: "groq", model: "whisper-large-v3", languages: ["en", "ar"] }) }] },
    { m: "GET", p: "/v1/transcriptions/{id}", a: "API key", bf: "none", s: "Get a transcription", d: "Fetch a transcription. text is populated once completed.",
      r: [{ s: 200, l: "OK", d: "The transcription.", ref: "Transcription", j: J({ id: "tr_8…", status: "completed", provider: "groq", text: "Alright, let's get started…", completed_at: ts }) }] } ] }
] };

/* ---------- normalize ---------- */
function normField(f) {
  return { id: nid("f"), name: f.n, type: f.t, required: !!f.r, desc: f.d || "", enumVals: f.e || "",
    ref: f.ref || "", arrayOf: f.of || "", children: (f.ch || []).map(normField) };
}
function normParam(p) {
  return { id: nid("p"), in: p.in, name: p.n, type: p.t || "string", required: p.in === "path" ? true : !!p.r, desc: p.d || "", enumVals: p.e || "" };
}
function normResp(r) { return { id: nid("r"), status: r.s, label: r.l, desc: r.d || "", json: r.j || "", schemaRef: r.ref || "" }; }
function normComp(c) { return { id: nid("cmp"), name: c.n, description: c.d || "", fields: (c.f || []).map(normField) }; }
function normalize(seed) {
  return { meta: { ...seed.meta },
    components: seed.components.map(normComp),
    categories: seed.categories.map(c => ({ id: nid("cat"), name: c.n, desc: c.d,
      endpoints: c.e.map(e => ({ id: nid("ep"), method: e.m, path: e.p, summary: e.s, description: e.d, auth: e.a, bodyFormat: e.bf,
        params: (e.prm || []).map(normParam), fields: (e.f || []).map(normField), responses: (e.r || []).map(normResp) })) })) };
}

/* ---------- state ---------- */
let spec, sel = { kind: "hero", id: null }, activeResp = {}, ctxFields = [], savedTimer;
function ensureShape(s) {
  if (!s || typeof s !== "object") s = {};
  s.meta = s.meta || { name: "API", baseUrl: "", version: "v1", description: "" };
  s.categories = Array.isArray(s.categories) ? s.categories : [];
  s.components = Array.isArray(s.components) ? s.components : normalize(SEED).components;
  s.categories.forEach(c => (c.endpoints || []).forEach(e => {
    e.params = e.params || []; e.responses = e.responses || [];
    e.responses.forEach(r => { if (r.schemaRef == null) r.schemaRef = ""; });
    const fix = fs => (fs || []).forEach(f => { f.ref = f.ref || ""; f.arrayOf = f.arrayOf || ""; f.children = f.children || []; fix(f.children); });
    fix(e.fields);
  }));
  return s;
}
function load() {
  try { const raw = localStorage.getItem(STORE); if (raw) { spec = ensureShape(JSON.parse(raw)); reseedIds(); return; } } catch (e) {}
  spec = normalize(SEED);
}
function reseedIds() {
  let max = 0; const scan = o => { if (o && o.id) { const m = /_(\w+)$/.exec(o.id); if (m) { const v = parseInt(m[1], 36); if (v > max) max = v; } } };
  const fw = fs => (fs || []).forEach(f => { scan(f); fw(f.children); });
  (spec.components || []).forEach(c => { scan(c); fw(c.fields); });
  spec.categories.forEach(c => { scan(c); c.endpoints.forEach(e => { scan(e); (e.params || []).forEach(scan); fw(e.fields); e.responses.forEach(scan); }); });
  uid = max;
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(spec)); } catch (e) {}
  const s = $("#saved"); s.textContent = "saved ✓"; s.classList.add("on");
  clearTimeout(savedTimer); savedTimer = setTimeout(() => { s.textContent = ""; s.classList.remove("on"); }, 1400);
  updateLintBadge();
}

/* ---------- helpers ---------- */
const allEndpoints = () => spec.categories.flatMap(c => c.endpoints.map(e => ({ c, e })));
const findEp = id => allEndpoints().find(x => x.e.id === id);
const findComp = id => spec.components.find(c => c.id === id);
const curEp = () => sel.kind === "ep" ? (findEp(sel.id) || {}).e : null;
const curComp = () => sel.kind === "schema" ? findComp(sel.id) : null;
const compNames = () => spec.components.map(c => c.name);
function walkFields(arr, fid) { for (const f of (arr || [])) { if (f.id === fid) return { f, arr }; const r = walkFields(f.children, fid); if (r) return r; } return null; }
function pathParams(p) { return (p.match(/\{(\w+)\}/g) || []).map(x => x.slice(1, -1)); }
function fmtPath(p) { return esc(p).replace(/\{(\w+)\}/g, '<span class="pp">{$1}</span>'); }
function typeClass(f) { if (f.type === "$ref") return "t-ref"; if (f.type === "array") return "t-array"; if (f.type === "object" || f.type === "jsonb") return "t-object"; if (f.type === "enum") return "t-enum"; return "t-" + f.type; }
function typeLabel(f) { if (f.type === "$ref") return f.ref || "$ref"; if (f.type === "array") { const i = f.arrayOf === "$ref" ? (f.ref || "?") : (f.arrayOf || "any"); return i + "[]"; } return f.type; }

const reJK = /"(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
function tintJSON(raw) {
  if (!raw) return ""; let out = "", last = 0, m; reJK.lastIndex = 0;
  while ((m = reJK.exec(raw))) {
    out += esc(raw.slice(last, m.index)); const tok = m[0];
    if (tok[0] === '"') { if (m[1]) { const q = tok.slice(0, tok.length - m[1].length); out += '<span class="jk">' + esc(q) + "</span>" + esc(m[1]); } else out += '<span class="js">' + esc(tok) + "</span>"; }
    else if (tok === "null") out += '<span class="jnull">null</span>';
    else if (tok === "true" || tok === "false") out += '<span class="jb">' + tok + "</span>";
    else out += '<span class="jn">' + tok + "</span>";
    last = m.index + tok.length;
  }
  return out + esc(raw.slice(last));
}
const opt = (v, s) => "<option" + (v === s ? " selected" : "") + ">" + v + "</option>";
const optRef = (n, s) => '<option value="' + esc(n) + '"' + (n === s ? " selected" : "") + ">" + (n || "(no schema)") + "</option>";

/* ---------- sidebar ---------- */
function renderNav() {
  const q = $("#q").value.trim().toLowerCase(); const nav = $("#nav"); nav.innerHTML = "";
  if (!q && spec.components.length) {
    const wrap = el("div", "cat" + (navState.schemas ? " collapsed" : ""));
    const head = el("div", "cat-head");
    head.innerHTML = caret() + '<span class="cat-name eyebrow">Schemas</span><span class="cat-count">' + spec.components.length + "</span>";
    const add = el("button", "cat-add", "+"); add.dataset.click = "add-schema"; head.appendChild(add);
    head.dataset.click = "toggle-schemas"; wrap.appendChild(head);
    const rows = el("div", "rows");
    spec.components.forEach(c => {
      const r = el("div", "srow" + (sel.kind === "schema" && sel.id === c.id ? " active" : ""), '<span class="gl">{}</span><span class="sn">' + esc(c.name) + "</span>");
      r.dataset.click = "select-schema"; r.dataset.id = c.id; rows.appendChild(r);
    });
    wrap.appendChild(rows); nav.appendChild(wrap);
  }
  spec.categories.forEach(cat => {
    const eps = cat.endpoints.filter(e => !q || (e.path + " " + e.summary + " " + e.method).toLowerCase().includes(q));
    if (q && !eps.length) return;
    const wrap = el("div", "cat" + (cat._collapsed ? " collapsed" : ""));
    const head = el("div", "cat-head");
    head.innerHTML = caret() + '<span class="cat-name eyebrow" contenteditable="true" spellcheck="false" data-edit="cat:name" data-cat="' + cat.id + '">' + esc(cat.name) + '</span><span class="cat-count">' + cat.endpoints.length + "</span>";
    const add = el("button", "cat-add", "+"); add.dataset.click = "cat-add"; add.dataset.cat = cat.id; add.title = "Add endpoint"; head.appendChild(add);
    head.dataset.click = "toggle-cat"; head.dataset.cat = cat.id; wrap.appendChild(head);
    const rows = el("div", "rows");
    eps.forEach(e => {
      const r = el("div", "row " + e.method + (sel.kind === "ep" && e.id === sel.id ? " active" : ""));
      r.style.setProperty("--m", "var(--" + e.method.toLowerCase() + ")");
      r.innerHTML = '<span class="verb ' + e.method + '">' + e.method + '</span><div><div class="rpath">' + fmtPath(e.path) + '</div><div class="rsum">' + esc(e.summary) + "</div></div>";
      r.dataset.click = "select-ep"; r.dataset.id = e.id; rows.appendChild(r);
    });
    wrap.appendChild(rows); nav.appendChild(wrap);
  });
}
const navState = { schemas: false };
const caret = () => '<svg class="caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>';

/* ---------- select / dispatch ---------- */
function select(kind, id) { sel = { kind, id }; if (kind === "ep" && activeResp[id] == null) activeResp[id] = 0; renderNav(); renderCurrent(); $("#detail").scrollTop = 0; }
function renderCurrent() { if (sel.kind === "schema") renderSchema(); else if (sel.kind === "ep") renderDetail(); else renderHero(); }

/* ---------- field rendering (recursive) ---------- */
function fieldList(fields, parentId) {
  const wrap = el("div", "field-list");
  (fields || []).forEach(f => wrap.appendChild(fieldBlock(f)));
  const add = el("button", "section-add add-prop", "＋ " + (parentId ? "property" : "field"));
  add.dataset.click = parentId ? "field-addprop" : "fields-add"; if (parentId) add.dataset.fid = parentId;
  wrap.appendChild(add); return wrap;
}
function typeCellHTML(f) {
  let main = '<div class="sub-sel"><span class="type-chip ' + typeClass(f) + '">' + esc(typeLabel(f)) + '</span>' +
    '<select class="type-pick" data-act="ftype" data-fid="' + f.id + '">' + TYPES.map(t => opt(t, f.type)).join("") + "</select></div>";
  let extra = "";
  if (f.type === "array") extra += '<select class="mini" data-act="farrayof" data-fid="' + f.id + '" title="element type">' + ARRAY_OF.map(t => opt(t, f.arrayOf || "string")).join("") + "</select>";
  if (f.type === "$ref" || (f.type === "array" && f.arrayOf === "$ref"))
    extra += '<select class="mini" data-act="fref" data-fid="' + f.id + '" title="schema">' + ["", ...compNames()].map(n => optRef(n, f.ref)).join("") + "</select>";
  if (extra) main += '<div class="sub-extra">' + extra + "</div>";
  return main;
}
function subLine(f) {
  if (f.type === "enum") return '<div class="f-enum"><span class="k">enum</span> <span contenteditable="true" spellcheck="false" data-edit="field:enumVals" data-fid="' + f.id + '" data-ph="a | b | c">' + esc(f.enumVals) + "</span></div>";
  if (f.type === "$ref") return '<div class="f-ref">→ ' + esc(f.ref || "pick a schema") + "</div>";
  if (f.type === "array" && f.arrayOf === "$ref") return '<div class="f-ref">→ ' + esc(f.ref || "pick a schema") + "[]</div>";
  if (f.type === "object") { const n = (f.children || []).length; return '<div class="f-sub">' + n + " propert" + (n === 1 ? "y" : "ies") + "</div>"; }
  return "";
}
const hasChildren = f => f.type === "object" || (f.type === "array" && f.arrayOf === "object");
function fieldBlock(f) {
  const block = el("div", "field-block");
  const row = el("div", "field" + (f.required ? " req" : ""));
  row.innerHTML =
    '<div class="req-mark" data-click="field-req" data-fid="' + f.id + '" title="Toggle required"><span class="box"></span></div>' +
    '<div class="f-main"><div class="f-name" contenteditable="true" spellcheck="false" data-edit="field:name" data-fid="' + f.id + '" data-ph="field_name">' + esc(f.name) + "</div>" +
      '<div class="f-req">' + (f.required ? "required" : "optional") + "</div>" + subLine(f) + "</div>" +
    '<div class="type-cell">' + typeCellHTML(f) + "</div>" +
    '<div class="f-desc" contenteditable="true" spellcheck="false" data-edit="field:desc" data-fid="' + f.id + '" data-ph="What is this field?">' + esc(f.desc) + "</div>" +
    '<button class="f-del" data-click="field-del" data-fid="' + f.id + '" title="Remove">✕</button>';
  block.appendChild(row);
  if (hasChildren(f)) { const ch = el("div", "field-children"); ch.appendChild(fieldList(f.children, f.id)); block.appendChild(ch); }
  return block;
}

/* ---------- endpoint detail ---------- */
function syncPathParams(e) {
  const names = pathParams(e.path);
  e.params = e.params.filter(p => p.in !== "path" || names.includes(p.name));
  names.forEach(n => { if (!e.params.some(p => p.in === "path" && p.name === n)) e.params.push({ id: nid("p"), in: "path", name: n, type: "string", required: true, desc: "", enumVals: "" }); });
  e.params.sort((a, b) => ({ path: 0, query: 1, header: 2 }[a.in] - { path: 0, query: 1, header: 2 }[b.in]));
}
function paramRow(p) {
  const row = el("div", "param");
  const nameCell = p.in === "path"
    ? '<span class="p-name mono">' + esc(p.name) + "</span>"
    : '<span class="p-name mono" contenteditable="true" spellcheck="false" data-edit="param:name" data-pid="' + p.id + '" data-ph="name">' + esc(p.name) + "</span>";
  const enumLine = p.type === "enum" ? '<div class="f-enum"><span class="k">enum</span> <span contenteditable="true" spellcheck="false" data-edit="param:enumVals" data-pid="' + p.id + '" data-ph="a | b | c">' + esc(p.enumVals) + "</span></div>" : "";
  const req = p.in === "path" ? '<span class="p-fixed">required</span>'
    : '<button class="req-toggle' + (p.required ? " on" : "") + '" data-click="param-req" data-pid="' + p.id + '">' + (p.required ? "required" : "optional") + "</button>";
  row.innerHTML =
    '<span class="in-badge in-' + p.in + '">' + p.in + "</span>" +
    '<div>' + nameCell + enumLine + "</div>" +
    '<div class="type-cell"><div class="sub-sel"><span class="type-chip ' + (p.type === "enum" ? "t-enum" : "t-" + p.type) + '">' + esc(p.type) + '</span><select data-act="ptype" data-pid="' + p.id + '">' + PARAM_TYPES.map(t => opt(t, p.type)).join("") + "</select></div></div>" +
    '<div class="p-req">' + req + "</div>" +
    '<div class="p-desc" contenteditable="true" spellcheck="false" data-edit="param:desc" data-pid="' + p.id + '" data-ph="Describe this parameter…">' + esc(p.desc) + "</div>" +
    (p.in === "path" ? "<span></span>" : '<button class="f-del" data-click="param-del" data-pid="' + p.id + '" title="Remove">✕</button>');
  return row;
}
function sectionHead(title, addsHTML) {
  const h = el("div", "section-head");
  h.innerHTML = '<span class="eyebrow">' + esc(title) + '</span><span class="rule"></span><div class="section-adds">' + (addsHTML || "") + "</div>";
  return h;
}
function renderDetail() {
  const e = curEp(); if (!e) return renderHero(); ctxFields = e.fields;
  syncPathParams(e);
  const inner = el("div", "detail-inner");
  const verbSel = '<select data-act="method">' + ["GET", "POST", "PUT", "PATCH", "DELETE"].map(v => opt(v, e.method)).join("") + "</select>";
  const head = el("div", "ep-head");
  head.innerHTML =
    '<div class="ep-verb ' + e.method + '">' + e.method + verbSel + "</div>" +
    '<div class="ep-path mono" contenteditable="true" spellcheck="false" data-edit="ep:path">' + fmtPath(e.path) + "</div>" +
    '<button class="btn ep-del" data-click="ep-del" title="Delete endpoint">✕</button>';
  inner.appendChild(head);
  inner.appendChild(el("div", "ep-summary", '<span contenteditable="true" spellcheck="false" data-edit="ep:summary" data-ph="Short summary…">' + esc(e.summary) + "</span>"));
  inner.appendChild(el("div", "ep-desc", '<span contenteditable="true" spellcheck="false" data-edit="ep:description" data-ph="Describe what this endpoint does…">' + esc(e.description) + "</span>"));

  const meta = el("div", "meta-row");
  meta.appendChild(metaPill("auth", "AUTH", e.auth, AUTHS));
  meta.appendChild(metaPill("bf", "BODY", e.bodyFormat, FORMATS));
  inner.appendChild(meta);

  // parameters
  const pSec = el("div", "section");
  pSec.appendChild(sectionHead("Parameters", '<button class="section-add" data-click="param-add" data-pin="query">＋ query</button><button class="section-add" data-click="param-add" data-pin="header">＋ header</button>'));
  if (!e.params.length) pSec.appendChild(el("div", "nobody", "No parameters."));
  else e.params.forEach(p => pSec.appendChild(paramRow(p)));
  inner.appendChild(pSec);

  // request body
  const rSec = el("div", "section");
  rSec.appendChild(sectionHead("Request body", e.bodyFormat === "none" ? "" : '<button class="section-add" data-click="fields-add">＋ field</button>'));
  if (e.bodyFormat === "none") rSec.appendChild(el("div", "nobody", "No request body."));
  else {
    const fh = el("div", "fields-head");
    fh.innerHTML = '<span></span><span class="eyebrow">Field</span><span class="eyebrow">Type</span><span class="eyebrow">Description</span><span></span>';
    rSec.appendChild(fh);
    if (!e.fields.length) rSec.appendChild(el("div", "nobody", "No fields yet — add one."));
    rSec.appendChild(fieldList(e.fields, null));
  }
  inner.appendChild(rSec);

  // responses
  inner.appendChild(responsesSection(e));

  $("#detail").innerHTML = ""; $("#detail").appendChild(inner); bindEditables($("#detail"));
}
function metaPill(kind, label, val, opts) {
  return el("span", "pill sel", '<span class="k">' + label + "</span> " + esc(val) +
    '<select data-act="' + kind + '">' + opts.map(o => "<option" + (o === val ? " selected" : "") + ">" + esc(o) + "</option>").join("") + "</select>");
}
function responsesSection(e) {
  const sec = el("div", "section");
  sec.appendChild(sectionHead("Responses", '<button class="section-add" data-click="resp-add">＋ response</button>'));
  const tabs = el("div", "resp-tabs");
  let ai = activeResp[e.id] || 0; if (ai >= e.responses.length) ai = 0;
  e.responses.forEach((r, i) => {
    const t = el("button", "resp-tab s" + String(r.status)[0] + (i === ai ? " active" : ""),
      '<span class="code">' + esc(r.status) + '</span><span class="lab">' + esc(r.label) + "</span>");
    t.dataset.click = "resp-tab"; t.dataset.ri = i; tabs.appendChild(t);
  });
  sec.appendChild(tabs);
  const r = e.responses[ai];
  if (r) {
    const body = el("div", "resp-body");
    const rm = el("div", "resp-meta");
    rm.innerHTML = '<span class="resp-desc" contenteditable="true" spellcheck="false" data-edit="resp:desc" data-ri="' + ai + '" data-ph="Describe this response…">' + esc(r.desc) + "</span>" +
      '<button class="resp-del" data-click="resp-del" data-ri="' + ai + '">remove</button>';
    body.appendChild(rm);
    const sch = el("div", "resp-schema");
    sch.innerHTML = '<span class="k">body schema</span><span class="schema-chip">' + esc(r.schemaRef || "—") +
      '<select data-act="respschema" data-ri="' + ai + '">' + ["", ...compNames()].map(n => optRef(n, r.schemaRef)).join("") + "</select></span>";
    body.appendChild(sch);
    if (r.json !== "") {
      const jw = el("div", "json-wrap");
      jw.innerHTML = '<button class="json-copy" data-click="json-copy" data-ri="' + ai + '">copy</button>';
      const pre = el("pre", "json mono"); pre.setAttribute("contenteditable", "true"); pre.setAttribute("spellcheck", "false");
      pre.dataset.edit = "resp:json"; pre.dataset.ri = ai; pre.dataset.raw = r.json; pre.innerHTML = tintJSON(r.json);
      jw.appendChild(pre); body.appendChild(jw);
    } else {
      const addj = el("button", "section-add", "＋ add JSON example"); addj.dataset.click = "resp-addjson"; addj.dataset.ri = ai; body.appendChild(addj);
    }
    sec.appendChild(body);
  }
  return sec;
}

/* ---------- schema view ---------- */
function renderSchema() {
  const c = curComp(); if (!c) return renderHero(); ctxFields = c.fields;
  const inner = el("div", "detail-inner");
  const head = el("div", "ep-head");
  head.innerHTML = '<div class="ep-verb" style="--m:var(--brand)">{}</div>' +
    '<div class="schema-name mono" contenteditable="true" spellcheck="false" data-edit="comp:name" data-ph="SchemaName">' + esc(c.name) + "</div>" +
    '<button class="btn ep-del" data-click="comp-del" title="Delete schema">✕</button>';
  inner.appendChild(head);
  inner.appendChild(el("div", "schema-desc", '<span contenteditable="true" spellcheck="false" data-edit="comp:description" data-ph="Describe this schema…">' + esc(c.description) + "</span>"));
  const sec = el("div", "section");
  sec.appendChild(sectionHead("Properties", '<button class="section-add" data-click="fields-add">＋ field</button>'));
  const fh = el("div", "fields-head");
  fh.innerHTML = '<span></span><span class="eyebrow">Field</span><span class="eyebrow">Type</span><span class="eyebrow">Description</span><span></span>';
  sec.appendChild(fh);
  if (!c.fields.length) sec.appendChild(el("div", "nobody", "No properties yet — add one."));
  sec.appendChild(fieldList(c.fields, null));
  inner.appendChild(sec);
  inner.appendChild(el("div", "section", '<div class="eyebrow" style="margin-bottom:10px">Referenced by</div><div class="nobody">' + refUsage(c.name) + "</div>"));
  $("#detail").innerHTML = ""; $("#detail").appendChild(inner); bindEditables($("#detail"));
}
function refUsage(name) {
  const hits = [];
  allEndpoints().forEach(({ e }) => {
    e.responses.forEach(r => { if (r.schemaRef === name) hits.push(e.method + " " + e.path + " · " + r.status); });
  });
  return hits.length ? hits.map(esc).join(" &nbsp;·&nbsp; ") : "Not referenced by any response yet.";
}

/* ---------- hero ---------- */
function renderHero() {
  const m = spec.meta; const eps = allEndpoints().length;
  const hero = el("div", "hero");
  hero.innerHTML =
    '<div class="eyebrow">' + esc(m.version || "v1") + ' · design board</div>' +
    "<h1>" + esc(m.name) + '<span class="dot">.</span></h1>' +
    '<p class="lede" contenteditable="true" spellcheck="false" data-edit="meta:description" data-ph="Describe your API…">' + esc(m.description) + "</p>" +
    '<div class="stats">' +
      '<div class="stat"><div class="n">' + eps + '</div><div class="l eyebrow">endpoints</div></div>' +
      '<div class="stat"><div class="n">' + spec.categories.length + '</div><div class="l eyebrow">categories</div></div>' +
      '<div class="stat"><div class="n">' + spec.components.length + '</div><div class="l eyebrow">schemas</div></div>' +
      '<div class="stat"><div class="n mono">' + esc(m.version || "v1") + '</div><div class="l eyebrow">version</div></div>' +
    "</div>";
  const jump = el("div", "jump");
  spec.categories.forEach(c => { const ch = el("button", "chip-cat", esc(c.name)); ch.dataset.click = "jump-cat"; ch.dataset.id = c.id; jump.appendChild(ch); });
  hero.appendChild(jump);
  hero.appendChild(el("div", "hint", "Pick an endpoint or schema to edit · everything is editable inline · <kbd>/</kbd> to search"));
  $("#detail").innerHTML = ""; $("#detail").appendChild(hero); bindEditables($("#detail"));
}

/* ---------- inline text editing ---------- */
function bindEditables(root) {
  root.querySelectorAll("[data-edit]").forEach(node => {
    if (node.tagName === "PRE") {
      node.addEventListener("focus", () => { node.textContent = node.dataset.raw || ""; });
      node.addEventListener("input", () => { node.dataset.raw = node.textContent; commit(node, node.textContent); });
      node.addEventListener("blur", () => { const t = node.dataset.raw || node.textContent; node.dataset.raw = t; node.innerHTML = tintJSON(t); });
    } else {
      node.addEventListener("input", () => commit(node, node.textContent));
      node.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); node.blur(); } });
      if (node.dataset.edit === "ep:path") node.addEventListener("blur", () => { const e = curEp(); if (e) { syncPathParams(e); renderDetail(); } });
    }
  });
}
function commit(node, val) {
  const [scope, key] = node.dataset.edit.split(":");
  if (scope === "meta") spec.meta[key] = val;
  else if (scope === "cat") { const c = spec.categories.find(x => x.id === node.dataset.cat); if (c) c[key] = val; }
  else if (scope === "ep") { const e = curEp(); if (e) { e[key] = val; if (key === "summary") liveRow(".rsum", val); if (key === "path") liveRow(".rpath", fmtPath(val), true); } }
  else if (scope === "field") { const r = walkFields(ctxFields, node.dataset.fid); if (r) r.f[key] = val; }
  else if (scope === "param") { const e = curEp(); const p = e && e.params.find(x => x.id === node.dataset.pid); if (p) p[key] = val; }
  else if (scope === "resp") { const e = curEp(); const rr = e && e.responses[+node.dataset.ri]; if (rr) rr[key] = val; }
  else if (scope === "comp") { const c = curComp(); if (c) c[key] = val; }
  save();
}
function liveRow(selc, html, isHTML) { const n = $(".row.active " + selc); if (n) { if (isHTML) n.innerHTML = html; else n.textContent = html; } }

/* ---------- structural ops ---------- */
const newField = () => ({ id: nid("f"), name: "", type: "string", required: false, desc: "", enumVals: "", ref: "", arrayOf: "", children: [] });
function rerender() { renderCurrent(); }
function onChange(ev) {
  const s = ev.target.closest("select[data-act]"); if (!s) return;
  const act = s.dataset.act, e = curEp();
  if (act === "method" && e) { e.method = s.value; save(); renderNav(); renderDetail(); return; }
  if (act === "auth" && e) { e.auth = s.value; save(); renderDetail(); return; }
  if (act === "bf" && e) { e.bodyFormat = s.value; save(); renderDetail(); return; }
  if (act === "ptype" && e) { const p = e.params.find(x => x.id === s.dataset.pid); if (p) p.type = s.value; save(); renderDetail(); return; }
  if (act === "respschema" && e) { const r = e.responses[+s.dataset.ri]; if (r) r.schemaRef = s.value; save(); renderDetail(); return; }
  if (act === "ftype") { const r = walkFields(ctxFields, s.dataset.fid); if (r) { r.f.type = s.value; if (s.value === "array" && !r.f.arrayOf) r.f.arrayOf = "string"; if (s.value === "object" && !r.f.children.length) r.f.children = r.f.children || []; } save(); rerender(); return; }
  if (act === "farrayof") { const r = walkFields(ctxFields, s.dataset.fid); if (r) { r.f.arrayOf = s.value; } save(); rerender(); return; }
  if (act === "fref") { const r = walkFields(ctxFields, s.dataset.fid); if (r) r.f.ref = s.value; save(); rerender(); return; }
}
function onClick(ev) {
  const t = ev.target.closest("[data-click]"); if (!t) return;
  const act = t.dataset.click, e = curEp();
  const map = {
    home() { sel = { kind: "hero", id: null }; renderNav(); renderHero(); },
    "select-ep"() { select("ep", t.dataset.id); },
    "select-schema"() { select("schema", t.dataset.id); },
    "toggle-cat"() { if (ev.target.closest("[contenteditable],.cat-add")) return; const c = spec.categories.find(x => x.id === t.dataset.cat); c._collapsed = !c._collapsed; renderNav(); },
    "toggle-schemas"() { if (ev.target.closest(".cat-add")) return; navState.schemas = !navState.schemas; renderNav(); },
    "cat-add"() { addEndpoint(t.dataset.cat); },
    "field-req"() { const r = walkFields(ctxFields, t.dataset.fid); if (r) { r.f.required = !r.f.required; save(); rerender(); } },
    "field-del"() { const r = walkFields(ctxFields, t.dataset.fid); if (r) { const i = r.arr.indexOf(r.f); r.arr.splice(i, 1); save(); rerender(); } },
    "field-addprop"() { const r = walkFields(ctxFields, t.dataset.fid); if (r) { r.f.children = r.f.children || []; r.f.children.push(newField()); save(); rerender(); } },
    "fields-add"() { ctxFields.push(newField()); save(); rerender(); focusLast(".f-name"); },
    "param-add"() { if (!e) return; e.params.push({ id: nid("p"), in: t.dataset.pin, name: "", type: "string", required: false, desc: "", enumVals: "" }); save(); renderDetail(); },
    "param-req"() { const p = e && e.params.find(x => x.id === t.dataset.pid); if (p) { p.required = !p.required; save(); renderDetail(); } },
    "param-del"() { if (!e) return; e.params = e.params.filter(x => x.id !== t.dataset.pid); save(); renderDetail(); },
    "resp-tab"() { if (e) { activeResp[e.id] = +t.dataset.ri; renderDetail(); } },
    "resp-add"() { addResponse(); },
    "resp-del"() { if (e && e.responses.length > 1) { e.responses.splice(+t.dataset.ri, 1); activeResp[e.id] = 0; save(); renderDetail(); } },
    "resp-addjson"() { if (e) { e.responses[+t.dataset.ri].json = "{\n  \n}"; save(); renderDetail(); } },
    "json-copy"() { if (e && navigator.clipboard) { navigator.clipboard.writeText(e.responses[+t.dataset.ri].json); t.textContent = "copied"; setTimeout(() => (t.textContent = "copy"), 1000); } },
    "ep-del"() { if (e && confirm("Delete " + e.method + " " + e.path + " ?")) deleteEndpoint(e.id); },
    "comp-del"() { const c = curComp(); if (c && confirm('Delete schema "' + c.name + '" ?')) { spec.components = spec.components.filter(x => x.id !== c.id); sel = { kind: "hero" }; save(); renderNav(); renderHero(); } },
    "jump-cat"() { const c = spec.categories.find(x => x.id === t.dataset.id); if (c && c.endpoints[0]) select("ep", c.endpoints[0].id); },
    "add-ep"() { addEndpoint(spec.categories[0] && spec.categories[0].id); },
    "add-cat"() { const c = { id: nid("cat"), name: "New category", desc: "", endpoints: [] }; spec.categories.push(c); save(); renderNav(); },
    "add-schema"() { const c = { id: nid("cmp"), name: "NewSchema", description: "", fields: [] }; spec.components.push(c); navState.schemas = false; save(); select("schema", c.id); },
    theme() { const r = document.documentElement; const n = r.dataset.theme === "paper" ? "slate" : "paper"; r.dataset.theme = n; localStorage.setItem("chalk.api.theme", n); },
    "export-toggle"() { $("#export-menu").classList.toggle("open"); ev.stopPropagation(); },
    "export-design"() { closeMenu(); download(slug() + ".design.json", JSON.stringify(spec, null, 2)); },
    "export-oas-json"() { closeMenu(); download(slug() + ".openapi.json", JSON.stringify(buildOpenAPI(), null, 2)); },
    "export-oas-yaml"() { closeMenu(); download(slug() + ".openapi.yaml", toYAML(buildOpenAPI())); },
    import() { $("#file").click(); },
    reset() { if (confirm("Reset to the default Chalk API design? Your edits will be lost.")) { localStorage.removeItem(STORE); uid = 0; spec = normalize(SEED); sel = { kind: "hero" }; renderNav(); renderHero(); updateLintBadge(); } },
    "lint-open"() { openLint(); },
    "lint-close"() { $("#drawer").classList.remove("open"); $("#scrim").classList.remove("open"); }
  };
  if (map[act]) map[act]();
}
function focusLast(selc) { setTimeout(() => { const ns = $("#detail").querySelectorAll(selc); const l = ns[ns.length - 1]; if (l) l.focus(); }, 0); }
function addEndpoint(catId) {
  const c = spec.categories.find(x => x.id === catId) || spec.categories[0]; if (!c) return;
  const e = { id: nid("ep"), method: "POST", path: "/v1/new-endpoint", summary: "New endpoint", description: "", auth: "API key", bodyFormat: "application/json",
    params: [], fields: [], responses: [{ id: nid("r"), status: 200, label: "OK", desc: "", json: "{\n  \n}", schemaRef: "" }] };
  c.endpoints.push(e); c._collapsed = false; save(); select("ep", e.id); focusLast(".ep-path");
}
function deleteEndpoint(id) { spec.categories.forEach(c => { c.endpoints = c.endpoints.filter(e => e.id !== id); }); sel = { kind: "hero" }; save(); renderNav(); renderHero(); }
function addResponse() {
  const e = curEp(); if (!e) return; const used = e.responses.map(r => +r.status);
  const st = !used.includes(200) ? 200 : !used.includes(400) ? 400 : 500;
  e.responses.push({ id: nid("r"), status: st, label: st >= 400 ? "Error" : "OK", desc: "", json: "{\n  \n}", schemaRef: st >= 400 ? "Error" : "" });
  activeResp[e.id] = e.responses.length - 1; save(); renderDetail();
}
const closeMenu = () => $("#export-menu").classList.remove("open");
const slug = () => (spec.meta.name || "api").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "api";
function download(name, text) { const b = new Blob([text], { type: "text/plain" }); const a = el("a"); a.href = URL.createObjectURL(b); a.download = name; a.click(); URL.revokeObjectURL(a.href); }

/* ---------- OpenAPI 3.1 ---------- */
function scalarSchema(t) {
  switch (t) {
    case "uuid": return { type: "string", format: "uuid" };
    case "url": return { type: "string", format: "uri" };
    case "inet": return { type: "string", format: "ipv4" };
    case "integer": return { type: "integer", format: "int64" };
    case "number": return { type: "number" };
    case "boolean": return { type: "boolean" };
    case "timestamptz": return { type: "string", format: "date-time" };
    case "jsonb": return { type: "object", additionalProperties: true };
    default: return { type: "string" };
  }
}
function fieldSchema(f) {
  let s;
  if (f.type === "$ref") s = f.ref ? { $ref: "#/components/schemas/" + f.ref } : {};
  else if (f.type === "enum") s = { type: "string", enum: splitEnum(f.enumVals) };
  else if (f.type === "object") s = objSchema(f.children);
  else if (f.type === "array") {
    let items = f.arrayOf === "$ref" ? (f.ref ? { $ref: "#/components/schemas/" + f.ref } : {})
      : f.arrayOf === "object" ? objSchema(f.children) : scalarSchema(f.arrayOf || "string");
    s = { type: "array", items };
  } else s = scalarSchema(f.type);
  if (f.desc) s.description = f.desc;
  return s;
}
function objSchema(fields, desc) {
  const properties = {}, required = [];
  (fields || []).forEach(f => { properties[f.name || "_"] = fieldSchema(f); if (f.required) required.push(f.name || "_"); });
  const s = { type: "object", properties };
  if (required.length) s.required = required;
  if (desc) s.description = desc;
  return s;
}
function parseEx(str) { if (!str || !str.trim()) return undefined; try { return JSON.parse(str); } catch (e) { return str; } }
function opId(e, used) {
  let base = e.summary ? e.summary.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, "")
    : e.method.toLowerCase() + e.path.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1)).join("");
  base = base || "op"; let id = base, i = 2; while (used.has(id)) id = base + i++; used.add(id); return id;
}
function buildOpenAPI() {
  const paths = {}, usedSec = {}, ids = new Set();
  spec.categories.forEach(cat => cat.endpoints.forEach(e => {
    const op = { tags: [cat.name], operationId: opId(e, ids) };
    if (e.summary) op.summary = e.summary;
    if (e.description) op.description = e.description;
    const prm = (e.params || []).map(p => { const o = { name: p.name, in: p.in, required: p.in === "path" ? true : !!p.required, schema: p.type === "enum" ? { type: "string", enum: splitEnum(p.enumVals) } : scalarSchema(p.type) }; if (p.desc) o.description = p.desc; return o; });
    if (prm.length) op.parameters = prm;
    if (e.bodyFormat !== "none" && (e.fields || []).length) op.requestBody = { required: true, content: { [e.bodyFormat]: { schema: objSchema(e.fields) } } };
    const responses = {};
    (e.responses || []).forEach(r => {
      const ro = { description: r.desc || r.label || String(r.status) };
      if (String(r.status) !== "204") {
        const media = {};
        if (r.schemaRef) media.schema = { $ref: "#/components/schemas/" + r.schemaRef };
        const ex = parseEx(r.json);
        if (!media.schema && ex !== undefined) media.schema = Array.isArray(ex) ? { type: "array" } : { type: "object" };
        if (ex !== undefined) media.example = ex;
        ro.content = { "application/json": media };
      }
      responses[String(r.status)] = ro;
    });
    op.responses = responses;
    if (e.auth === "API key") { op.security = [{ apiKeyAuth: [] }]; usedSec.apiKeyAuth = 1; }
    else if (e.auth === "Bearer (user)") { op.security = [{ userAuth: [] }]; usedSec.userAuth = 1; }
    else op.security = [];
    paths[e.path] = paths[e.path] || {};
    paths[e.path][e.method.toLowerCase()] = op;
  }));
  const schemas = {};
  spec.components.forEach(c => { schemas[c.name] = objSchema(c.fields, c.description); });
  const securitySchemes = {};
  if (usedSec.apiKeyAuth) securitySchemes.apiKeyAuth = { type: "http", scheme: "bearer", description: "Tenant API key, sent as a Bearer token." };
  if (usedSec.userAuth) securitySchemes.userAuth = { type: "http", scheme: "bearer", description: "User session token." };
  const components = { schemas };
  if (Object.keys(securitySchemes).length) components.securitySchemes = securitySchemes;
  const info = { title: spec.meta.name || "API", version: spec.meta.version || "v1" };
  if (spec.meta.description) info.description = spec.meta.description;
  return { openapi: "3.1.0", info, servers: [{ url: spec.meta.baseUrl || "/" }],
    tags: spec.categories.map(c => c.desc ? { name: c.name, description: c.desc } : { name: c.name }),
    paths, components };
}

/* ---------- minimal YAML emitter ---------- */
const isMap = v => v && typeof v === "object" && !Array.isArray(v);
const yKey = k => /^[A-Za-z_][\w.-]*$/.test(k) ? k : JSON.stringify(k);
const yScalar = v => v === null ? "null" : (typeof v === "number" || typeof v === "boolean") ? String(v) : JSON.stringify(String(v));
function emitKV(keyCol, childCol, k, v) {
  if (isMap(v)) { const ks = Object.keys(v).filter(x => v[x] !== undefined); return ks.length ? keyCol + yKey(k) + ":\n" + emitMap(v, childCol) : keyCol + yKey(k) + ": {}\n"; }
  if (Array.isArray(v)) return v.length ? keyCol + yKey(k) + ":\n" + emitSeq(v, childCol) : keyCol + yKey(k) + ": []\n";
  return keyCol + yKey(k) + ": " + yScalar(v) + "\n";
}
function emitMap(obj, col) { let out = ""; for (const k of Object.keys(obj)) { if (obj[k] === undefined) continue; out += emitKV(col, col + "  ", k, obj[k]); } return out; }
function emitSeq(arr, col) {
  let out = "";
  for (const item of arr) {
    if (isMap(item)) {
      const ks = Object.keys(item).filter(x => item[x] !== undefined);
      if (!ks.length) { out += col + "- {}\n"; continue; }
      ks.forEach((k, i) => { out += emitKV(i === 0 ? col + "- " : col + "  ", col + "    ", k, item[k]); });
    } else if (Array.isArray(item)) out += col + "-\n" + emitSeq(item, col + "  ");
    else out += col + "- " + yScalar(item) + "\n";
  }
  return out;
}
const toYAML = doc => emitMap(doc, "");

/* ---------- lint ---------- */
function lint() {
  const out = []; const add = (sev, msg, target) => out.push({ sev, msg, target });
  if (!spec.meta.baseUrl) add("warn", "Base URL is empty.");
  if (!spec.meta.name) add("warn", "API has no name.");
  const names = new Set(compNames()); const used = new Set(); const seen = {};
  spec.categories.forEach(cat => {
    if (!cat.name) add("warn", "A category has no name.");
    cat.endpoints.forEach(e => {
      const tgt = { kind: "ep", id: e.id }, at = e.method + " " + e.path;
      const key = e.method + " " + e.path; if (seen[key]) add("error", "Duplicate route: " + at, tgt); seen[key] = 1;
      if (!/^\//.test(e.path)) add("error", "Path should start with “/”: " + at, tgt);
      if (!e.summary) add("warn", "Missing summary — " + at, tgt);
      if (!e.description) add("info", "No description — " + at, tgt);
      if (!e.responses.length) add("error", "No responses defined — " + at, tgt);
      const hasErr = e.responses.some(r => /^[45]/.test(String(r.status)));
      if (/POST|PUT|PATCH|DELETE/.test(e.method) && !hasErr) add("warn", "No error response (4xx/5xx) — " + at, tgt);
      if (e.bodyFormat !== "none" && /POST|PUT|PATCH/.test(e.method) && !e.fields.length) add("info", "Body format set but no fields — " + at, tgt);
      pathParams(e.path).forEach(pn => { const p = e.params.find(x => x.in === "path" && x.name === pn); if (p && !p.desc) add("info", "Path param “" + pn + "” has no description — " + at, tgt); });
      e.params.forEach(p => { if (!p.name) add("warn", "A " + p.in + " param has no name — " + at, tgt); else if (p.in !== "path" && !p.desc) add("info", p.in + " param “" + p.name + "” has no description — " + at, tgt); });
      const wf = fs => (fs || []).forEach(f => {
        if (!f.name) add("error", "Field with no name — " + at, tgt);
        if (f.type === "enum" && !splitEnum(f.enumVals).length) add("warn", "Enum “" + (f.name || "?") + "” has no values — " + at, tgt);
        const ref = (f.type === "$ref" || (f.type === "array" && f.arrayOf === "$ref")) ? f.ref : null;
        if (f.type === "$ref" && !f.ref) add("warn", "$ref field “" + f.name + "” has no schema — " + at, tgt);
        if (ref) { if (!names.has(ref)) add("error", "Field “" + f.name + "” → missing schema “" + ref + "” — " + at, tgt); else used.add(ref); }
        wf(f.children);
      });
      wf(e.fields);
      const st = {};
      e.responses.forEach(r => {
        if (st[r.status]) add("warn", "Duplicate status " + r.status + " — " + at, tgt); st[r.status] = 1;
        if (r.schemaRef) { if (!names.has(r.schemaRef)) add("error", "Response " + r.status + " → missing schema “" + r.schemaRef + "” — " + at, tgt); else used.add(r.schemaRef); }
        if (String(r.status) !== "204" && !r.json && !r.schemaRef) add("info", "Response " + r.status + " has no example or schema — " + at, tgt);
      });
    });
  });
  spec.components.forEach(c => {
    const tgt = { kind: "schema", id: c.id };
    if (!c.fields.length) add("warn", "Schema “" + c.name + "” has no fields.", tgt);
    if (!used.has(c.name) && c.name !== "Error") add("info", "Schema “" + c.name + "” is never referenced.", tgt);
  });
  const rank = { error: 0, warn: 1, info: 2 };
  out.sort((a, b) => rank[a.sev] - rank[b.sev]);
  return out;
}
function updateLintBadge() {
  const L = lint(); const b = $("#lint-badge");
  const err = L.filter(x => x.sev === "error").length, warn = L.filter(x => x.sev === "warn").length;
  b.textContent = L.length; b.className = "badge" + (err ? " err" : warn ? " warn" : "");
}
function openLint() {
  const L = lint(); const list = $("#lint-list"); list.innerHTML = "";
  const c = { error: L.filter(x => x.sev === "error").length, warn: L.filter(x => x.sev === "warn").length, info: L.filter(x => x.sev === "info").length };
  $("#lint-sum").innerHTML = '<span><b>' + c.error + "</b> errors</span><span><b>" + c.warn + "</b> warnings</span><span><b>" + c.info + "</b> notes</span>";
  if (!L.length) list.innerHTML = '<div class="lint-clean">No issues — your design is clean. ✓</div>';
  L.forEach(it => {
    const row = el("div", "lint-item", '<span class="dot ' + it.sev + '"></span><span class="lint-msg">' + esc(it.msg) + "</span>");
    if (it.target) { row.addEventListener("click", () => { select(it.target.kind, it.target.id); $("#drawer").classList.remove("open"); $("#scrim").classList.remove("open"); }); }
    list.appendChild(row);
  });
  $("#drawer").classList.add("open"); $("#scrim").classList.add("open");
}

/* ---------- boot ---------- */
document.addEventListener("click", onClick);
document.addEventListener("change", onChange);
document.addEventListener("click", ev => { if (!ev.target.closest(".menu-wrap")) closeMenu(); });
$("#q").addEventListener("input", renderNav);
$("#file").addEventListener("change", ev => {
  const file = ev.target.files[0]; if (!file) return; const fr = new FileReader();
  fr.onload = () => { try { spec = ensureShape(JSON.parse(fr.result)); reseedIds(); sel = { kind: "hero" }; save(); renderNav(); renderHero(); } catch (e) { alert("Could not parse that JSON."); } };
  fr.readAsText(file); ev.target.value = "";
});
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape") { $("#drawer").classList.remove("open"); $("#scrim").classList.remove("open"); closeMenu(); }
  if (ev.key === "/" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable) { ev.preventDefault(); $("#q").focus(); }
});
load();
document.documentElement.dataset.theme = localStorage.getItem("chalk.api.theme") || "paper";
$("#baseurl").textContent = spec.meta.baseUrl;
bindEditables($(".topbar"));
renderNav(); renderHero(); updateLintBadge();
