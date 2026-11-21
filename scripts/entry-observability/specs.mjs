// @ts-check
/**
 * Deterministic fault scenarios for the Slice 1 (entry) checks. Each spec names the declaration the attempt/episode/platform
 * day stands for, the rows every witness would produce in the fault (positive) and healthy control, and — for checks whose
 * witnesses are Postgres rows — the seed SQL and the SELECT that reads the rows back on real Postgres. The fault test applies
 * the seed and runs the SELECT, so those rows are Postgres's own, never hand-written.
 *
 * Rows are C1-envelope shape: kind + name + event_id + est_server_ms + subject ids + the fact's claim field. A row for a
 * subject other than the item's (another client session, another admission request) proves the source emitted while leaving
 * the item's fact provably absent.
 */

export const T0 = 1_795_600_000_000;
const HOUR = 3_600_000;

export const TENANT = "10000000-0000-4000-8000-000000000001";
export const SPACE = "a0000000-0000-4000-8000-000000000002";
export const EP = "e0000000-0000-4000-8000-000000000003";
export const PT_GUEST = "b0000000-0000-4000-8000-000000000004";
export const PT_HOST = "c0000000-0000-4000-8000-000000000005";
export const USR_HOST = "d0000000-0000-4000-8000-000000000006";
export const ARR = "f0000000-0000-4000-8000-000000000007";
export const REQ = "90000000-0000-4000-8000-000000000008";
export const CS = "cs_spec_fault";
export const CS_OTHER = "cs_spec_other";
export const CS_HOST = "cs_spec_host";

let n = 0;
/** @param {string} kind @param {string} name @param {number} at @param {Record<string, unknown>} fields */
const row = (kind, name, at, fields) => ({ kind, name, event_id: `ev_${name.replaceAll(".", "_")}_${String(++n).padStart(3, "0")}`, est_server_ms: at, ...fields });
/** @param {string} name @param {number} at @param {Record<string, unknown>} fields */
const fact = (name, at, fields) => row("fact", name, at, fields);
const attempt = (/** @type {string} */ id, /** @type {number} */ len = HOUR) => ({ kind: /** @type {const} */ ("attempt"), id, tenant: TENANT, window: { from_ms: T0, to_ms: T0 + len } });
const episode = (seats, len = HOUR) => ({ kind: /** @type {const} */ ("episode"), id: EP, tenant: TENANT, features: ["media"], window: { from_ms: T0, to_ms: T0 + len }, seats });
const seat = (/** @type {string} */ participant, /** @type {"host"|"guest"|"collaborator"} */ role, person) => ({ participant, name: "Spec", role, can_publish: true, generations: [1], connections: ["cn_1"], window: { from_ms: T0, to_ms: T0 + HOUR }, person });
const platform = () => ({ kind: /** @type {const} */ ("platform"), id: "test", tenant: null, day: "2026-11-18", window: { from_ms: T0, to_ms: T0 + HOUR } });
const tenantDay = () => ({ kind: /** @type {const} */ ("tenant"), id: TENANT, tenant: TENANT, day: "2026-11-18", window: { from_ms: T0, to_ms: T0 + HOUR } });

const started = (/** @type {string} */ cs, /** @type {number} */ at, extra = {}) => fact("boot.started", at, { entry_path: "space_public", framed: false, policy_camera: "true", policy_microphone: "true", visibility: "visible", storage_state: "persistent", client_session_id: cs, device_id: "dev_spec", device_ephemeral: false, app_build: "spec", ...extra });

const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

/** @typedef {{ description: string, asof_ms: number, declaration: object, pg?: { seed: string, select: string }, healthy_pg?: { seed: string, select: string }, positive: { rows: object[] }, healthy: { rows: object[] }, expect: { hop: string | null, outcome: string } }} Spec */

/** @type {Readonly<Record<string, Spec>>} */
export const SPECS = {
  "admission.unresolved": {
    description: "The attempt's arrival and knock were written, but no admission decision was ever recorded for its client session. The decision events exist only for another session.",
    asof_ms: T0 + HOUR,
    declaration: attempt(CS),
    expect: { hop: "api_admission", outcome: "broken" },
    pg: {
      seed: `insert into tenants values('${TENANT}','Spec'); insert into spaces(id,name,tenant_id,slug,media_plane,updated_at) values('${SPACE}','spec','${TENANT}','spec-space','sfu','${iso(T0 - 9000)}');`,
      select: `select jsonb_build_object('kind','fact','name','admission.db.request','event_id','db:req:'||left(request_handle::text,8),'est_server_ms',(extract(epoch from requested_at)*1000)::bigint,'admission_status',state,'requested_at',(extract(epoch from requested_at)*1000)::bigint,'expires_at',(extract(epoch from expires_at)*1000)::bigint,'arrival_handle',arrival_handle,'admission_request_id',request_handle,'space_id',space_id,'tenant_id',tenant_id,'client_session_id','cs_spec_fault') from space_public_admission_requests`,
    },
    positive: {
      rows: [
        fact("invite.resolve", T0 + 5000, { decision: "admitted", reason_code: "", credential_kind: "code", state_epoch: 1, invite_generation: 1, arrival_handle: ARR, user_id: "", space_id: SPACE, tenant_id: TENANT, client_session_id: CS_OTHER }),
        fact("admission.decided", T0 + 6000, { decision: "admitted", reason_code: "", admission_request_id: REQ, arrival_handle: ARR, client_session_id: CS_OTHER }),
        fact("admission.outcome", T0 + 6100, { decision: "admitted", reason_code: "", arrival_handle: ARR, client_session_id: CS_OTHER }),
      ],
    },
    healthy: {
      rows: [
        fact("invite.resolve", T0 + 5000, { decision: "admitted", reason_code: "", credential_kind: "code", state_epoch: 1, invite_generation: 1, arrival_handle: ARR, user_id: "", space_id: SPACE, tenant_id: TENANT, client_session_id: CS }),
        fact("admission.decided", T0 + 6000, { decision: "admitted", reason_code: "", admission_request_id: REQ, arrival_handle: ARR, client_session_id: CS }),
        fact("admission.outcome", T0 + 6100, { decision: "admitted", reason_code: "", arrival_handle: ARR, client_session_id: CS }),
      ],
    },
  },
  "invite.refused": {
    description: "The API refused an invite as disabled, but the invite row at the decision's state_epoch is enabled with no disabled_at: a refusal its own rows contradict.",
    asof_ms: T0 + HOUR,
    declaration: attempt(CS),
    expect: { hop: "invite_resolve", outcome: "broken" },
    pg: {
      seed: `insert into tenants values('${TENANT}','Spec'); insert into spaces(id,name,tenant_id,slug,media_plane,updated_at) values('${SPACE}','spec','${TENANT}','spec-space','sfu','${iso(T0 - 9000)}'); insert into space_public_invites(tenant_id,space_id,handle,generation,state_epoch,enabled,admission_mode) values('${TENANT}','${SPACE}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),3,7,true,'open'); insert into space_public_arrivals(arrival_handle,tenant_id,space_id,invite_handle,invite_generation,invite_state_epoch,identity_mode,display_name,guest_credential_hash,idempotency_key,idempotency_fingerprint,state,expires_at,created_at) values('${ARR}','${TENANT}','${SPACE}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),3,7,'guest','Spec',decode('1111111111111111111111111111111111111111111111111111111111111111','hex'),'idem1',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),'pending','${iso(T0 + 3_600_000)}','${iso(T0)}'); insert into users(id,name,email) values('${USR_HOST}','Spec','spec@example.invalid'); insert into memberships(id,tenant_id,user_id,role,created_at) values('30000000-0000-4000-8000-000000000009','${TENANT}','${USR_HOST}','member','${iso(T0 - 60000)}');`,
      select: `select jsonb_build_object('kind','fact','name','invite.db.invite','event_id','db:inv:1','est_server_ms',${T0 + 4000},'enabled',enabled,'disabled_at',null,'rotated_at',null,'invite_generation',generation,'state_epoch',state_epoch,'space_id',space_id,'tenant_id',tenant_id,'client_session_id','cs_spec_fault') from space_public_invites union all select jsonb_build_object('kind','fact','name','invite.db.space','event_id','db:sp:1','est_server_ms',${T0 + 4000},'archived_at',(extract(epoch from archived_at)*1000)::bigint,'updated_at',(extract(epoch from updated_at)*1000)::bigint,'admission_mode',(select i.admission_mode from space_public_invites i where i.tenant_id=spaces.tenant_id and i.space_id=spaces.id),'space_id',id,'tenant_id',tenant_id,'client_session_id','cs_spec_fault') from spaces union all select jsonb_build_object('kind','fact','name','admission.db.arrival','event_id','db:arr:1','est_server_ms',(extract(epoch from created_at)*1000)::bigint,'arrival_state',state,'terminal_reason',coalesce(terminal_reason,'none'),'completed_at',(extract(epoch from terminal_at)*1000)::bigint,'invite_generation',invite_generation,'created_at',(extract(epoch from created_at)*1000)::bigint,'arrival_handle',arrival_handle,'space_id',space_id,'tenant_id',tenant_id,'client_session_id','cs_spec_fault') from space_public_arrivals union all select jsonb_build_object('kind','fact','name','invite.db.membership','event_id','db:mb:1','est_server_ms',${T0 + 4000},'created_at',(extract(epoch from created_at)*1000)::bigint,'user_id',user_id,'tenant_id',tenant_id,'client_session_id','cs_spec_fault') from memberships`,
    },
    healthy_pg: {
      seed: `insert into tenants values('${TENANT}','Spec'); insert into spaces(id,name,tenant_id,slug,media_plane,updated_at) values('${SPACE}','spec','${TENANT}','spec-space','sfu','${iso(T0 - 9000)}'); insert into space_public_invites(tenant_id,space_id,handle,generation,state_epoch,enabled,admission_mode) values('${TENANT}','${SPACE}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),3,7,true,'open'); insert into users(id,name,email) values('${USR_HOST}','Spec','spec@example.invalid'); insert into memberships(id,tenant_id,user_id,role,created_at) values('30000000-0000-4000-8000-000000000009','${TENANT}','${USR_HOST}','member','${iso(T0 - 60000)}');`,
      select: `select jsonb_build_object('kind','fact','name','invite.db.invite','event_id','db:inv:1','est_server_ms',${T0 + 4000},'enabled',enabled,'disabled_at',null,'rotated_at',null,'invite_generation',generation,'state_epoch',state_epoch,'space_id',space_id,'tenant_id',tenant_id,'client_session_id','cs_spec_fault') from space_public_invites union all select jsonb_build_object('kind','fact','name','invite.db.space','event_id','db:sp:1','est_server_ms',${T0 + 4000},'archived_at',(extract(epoch from archived_at)*1000)::bigint,'updated_at',(extract(epoch from updated_at)*1000)::bigint,'admission_mode',(select i.admission_mode from space_public_invites i where i.tenant_id=spaces.tenant_id and i.space_id=spaces.id),'space_id',id,'tenant_id',tenant_id,'client_session_id','cs_spec_fault') from spaces`,
    },
    positive: {
      rows: [
        fact("invite.resolve", T0 + 5000, { decision: "refused", reason_code: "invite.disabled", credential_kind: "code", state_epoch: 7, invite_generation: 3, arrival_handle: ARR, user_id: USR_HOST, space_id: SPACE, tenant_id: TENANT, client_session_id: CS }),
      ],
    },
    healthy: {
      rows: [
        fact("invite.resolve", T0 + 5000, { decision: "admitted", reason_code: "", credential_kind: "code", state_epoch: 7, invite_generation: 3, arrival_handle: ARR, user_id: "", space_id: SPACE, tenant_id: TENANT, client_session_id: CS }),
        fact("admission.db.arrival", T0, { arrival_state: "admitted", terminal_reason: "admitted", completed_at: T0 + 6000, invite_generation: 3, created_at: T0, arrival_handle: ARR, space_id: SPACE, tenant_id: TENANT }),
        fact("invite.db.membership", T0 + 4000, { created_at: T0 - 5000, user_id: USR_HOST, tenant_id: TENANT }),
      ],
    },
  },
  "boot.app_failed": {
    description: "The beacon ran and the page was visible, but render threw before the first screen and the root error page showed.",
    asof_ms: T0 + HOUR,
    declaration: attempt(CS),
    expect: { hop: "client_render", outcome: "broken" },
    positive: {
      rows: [
        started(CS, T0),
        fact("entry.record", T0 + 50, { record_name: "boot.started", entry_path: "space_public", client_session_id: CS, app_build: "spec" }),
        fact("boot.visible", T0 + 100, { client_session_id: CS }),
        fact("boot.render_failed", T0 + 900, { route_id: "/_space/x", error_name: "TypeError", error_class: "other", error_fingerprint: "fp1", client_session_id: CS }),
        fact("boot.error_page", T0 + 1000, { surface_state: "shown", shown_ms: T0 + 1000, route_id: "/_space/x", client_session_id: CS }),
        fact("boot.app", T0 + 2000, { surface_state: "shown", shown_ms: T0 + 2000, client_session_id: CS_OTHER }),
        fact("boot.pagehide", T0 + 3000, { app_shown: false, client_session_id: CS }),
        fact("boot.chunk_failed", T0 + 2500, { reloaded: false, client_session_id: CS_OTHER, device_id: "dev_o", device_ephemeral: false }),
        fact("boot.load_call_ui", T0 + 4000, { outcome: "ok", reason_code: "", duration_ms: 100, client_session_id: CS_OTHER }),
      ],
    },
    healthy: {
      rows: [
        started(CS, T0),
        fact("entry.record", T0 + 50, { record_name: "boot.started", entry_path: "space_public", client_session_id: CS, app_build: "spec" }),
        fact("boot.visible", T0 + 100, { client_session_id: CS }),
        fact("boot.app", T0 + 900, { surface_state: "shown", shown_ms: T0 + 900, client_session_id: CS }),
        fact("boot.load_call_ui", T0 + 3000, { outcome: "ok", reason_code: "", duration_ms: 200, client_session_id: CS }),
      ],
    },
  },
  "boot.never_ran": {
    description: "Edge served Space documents to real browsers for a 15-minute window and no script ran in any of them; the same build ran on those paths before and after.",
    asof_ms: T0 + HOUR,
    declaration: { kind: /** @type {const} */ ("platform"), id: "test", tenant: null, day: "2026-11-18", window: { from_ms: T0 - 86_400_000, to_ms: T0 + HOUR } },
    expect: { hop: "edge_document", outcome: "broken" },
    positive: {
      rows: [
        fact("edge.http_rollup", T0, { path_class: "space_page", content_class: "html", ua_class: "browser", edge_status: 200, request_count: 25, window_start_ms: T0, window_end_ms: T0 + 900_000, duration_ms: 900_000 }),
        fact("edge.http_rollup", T0 + 900_000, { path_class: "space_page", content_class: "html", ua_class: "browser", edge_status: 200, request_count: 25, window_start_ms: T0 + 900_000, window_end_ms: T0 + 1_800_000, duration_ms: 900_000 }),
        fact("entry.record", T0 - 60_000, { record_name: "boot.started", entry_path: "space_public", client_session_id: CS_OTHER, app_build: "spec" }),
        fact("entry.record", T0 + 1_900_000, { record_name: "boot.started", entry_path: "space_public", client_session_id: CS_OTHER, app_build: "spec" }),
        fact("boot.started", T0 + 2_000_000, { entry_path: "space_public", framed: false, policy_camera: "true", policy_microphone: "true", visibility: "visible", storage_state: "persistent", client_session_id: CS_OTHER, device_id: "dev_spec", device_ephemeral: false, app_build: "spec" }),
      ],
    },
    healthy: {
      rows: [
        fact("edge.http_rollup", T0, { path_class: "space_page", content_class: "html", ua_class: "browser", edge_status: 200, request_count: 25, window_start_ms: T0, window_end_ms: T0 + 900_000, duration_ms: 900_000 }),
        fact("entry.record", T0 - 60_000, { record_name: "boot.started", entry_path: "space_public", client_session_id: CS_OTHER, app_build: "spec" }),
        fact("entry.record", T0 + 300_000, { record_name: "boot.started", entry_path: "space_public", client_session_id: CS_OTHER, app_build: "spec" }),
        fact("entry.record", T0 + 1_900_000, { record_name: "boot.started", entry_path: "space_public", client_session_id: CS_OTHER, app_build: "spec" }),
      ],
    },
  },
  "prejoin.devices_blocked": {
    description: "The Permissions Policy already denied camera in this document and the prejoin machine went to blocked on permission_query — no visitor refusal was involved.",
    asof_ms: T0 + HOUR,
    declaration: attempt(CS),
    expect: { hop: "host_permissions_policy", outcome: "broken" },
    positive: {
      rows: [
        started(CS, T0, { framed: true, policy_camera: "false" }),
        fact("entry.record", T0 + 50, { record_name: "boot.started", entry_path: "space_public", client_session_id: CS, app_build: "spec" }),
        row("transition", "prejoin.access_edge", T0 + 500, { from_state: "checking", to_state: "blocked", trigger: "permission_query", error_name: "NotAllowedError", client_session_id: CS }),
      ],
    },
    healthy: {
      rows: [
        started(CS, T0),
        row("transition", "prejoin.access_edge", T0 + 500, { from_state: "checking", to_state: "ready", trigger: "device_labels", error_name: "", client_session_id: CS }),
      ],
    },
  },
  "prejoin.preview_failed": {
    description: "The camera device open failed with NotReadableError — not a refusal and not an absent device.",
    asof_ms: T0 + HOUR,
    declaration: attempt(CS),
    expect: { hop: "client_capture", outcome: "broken" },
    positive: {
      rows: [fact("prejoin.device_error", T0 + 700, { device: "camera", error_name: "NotReadableError", client_session_id: CS })],
    },
    healthy: {
      rows: [fact("prejoin.device_error", T0 + 700, { device: "camera", error_name: "NotReadableError", client_session_id: CS_OTHER })],
    },
  },
  "dashboard.request_failed": {
    description: "The dashboard's call page request failed 503 at the function while its upstream API answered 200: the failure is the dashboard's own hop.",
    asof_ms: T0 + HOUR,
    declaration: platform(),
    expect: { hop: "dashboard_function", outcome: "broken" },
    positive: {
      rows: [
        fact("dashboard.request_failed", T0 + 1000, { page: "call", method: "GET", http_status: 503, auth_result: "missing", upstream_status: 0, upstream_journey_id: "", client_session_id: CS, event: "dashboard.request_failed" }),
        fact("http.request", T0 + 900, { http_route: "/v1/dashboard/call", http_status: 200, method: "GET", event: "http.request" }),
      ],
    },
    healthy: {
      rows: [
        fact("dashboard.request_failed", T0 + 1000, { page: "call", method: "GET", http_status: 200, auth_result: "missing", upstream_status: 200, upstream_journey_id: "", client_session_id: CS, event: "dashboard.request_failed" }),
        fact("http.request", T0 + 900, { http_route: "/v1/dashboard/call", http_status: 200, method: "GET", event: "http.request" }),
      ],
    },
  },
  "embed.blocked": {
    description: "The API issued embed grants (2xx) for the tenant's day, but no request under a grant ever reached Chalk — the host page blocked the frame's requests.",
    asof_ms: T0 + HOUR,
    declaration: tenantDay(),
    expect: { hop: "host_csp", outcome: "broken" },
    pg: {
      seed: `insert into tenants values('${TENANT}','Spec'); insert into spaces(id,name,tenant_id,slug,media_plane,updated_at) values('${SPACE}','spec','${TENANT}','spec-space','sfu','${iso(T0 - 9000)}'); insert into episodes(id,status,space_id,tenant_id,config_snapshot) values('${EP}','active','${SPACE}','${TENANT}','{}'); insert into participants(id,capabilities,tenant_id,space_id,episode_id,generation,status,role,joined_at) values('${PT_HOST}','{manageAdmission}','${TENANT}','${SPACE}','${EP}',1,'active','guest','${iso(T0 - 8000)}');`,
      select: `select jsonb_build_object('kind','fact','name','embed.db.episode','event_id','db:ep:1','est_server_ms',${T0 + 4000},'episode_status',status,'ended_at',null,'episode_id',id,'tenant_id',tenant_id) from episodes union all select jsonb_build_object('kind','fact','name','admission.db.participant','event_id','db:pt:'||left(id::text,8),'est_server_ms',${T0 + 4000},'participant_status',status,'manage_admission',(capabilities @> '{manageAdmission}'),'joined_at',(extract(epoch from joined_at)*1000)::bigint,'participant_id',id,'episode_id',episode_id) from participants`,
    },
    positive: {
      rows: [
        fact("http.request", T0 + 5000, { http_route: "/v1/tenants/:tenant_id/participants/:participant_id/access-grants", http_status: 200, method: "POST", participant_id: PT_GUEST, tenant_id: TENANT, event: "http.request" }),
        fact("http.request", T0 + 60_000, { http_route: "/v1/tenants/:tenant_id/participants/:participant_id/access-grants", http_status: 200, method: "POST", participant_id: PT_HOST, tenant_id: TENANT, event: "http.request" }),
        fact("sync.websocket.authenticated", T0 + 1000, { participant_id_hash: "h_other", participant_id: "99999999-0000-4000-8000-000000000077", event: "sync.websocket.authenticated" }),
      ],
    },
    healthy: {
      rows: [
        fact("http.request", T0 + 5000, { http_route: "/v1/tenants/:tenant_id/participants/:participant_id/access-grants", http_status: 200, method: "POST", participant_id: PT_GUEST, tenant_id: TENANT, event: "http.request" }),
        fact("http.request", T0 + 60_000, { http_route: "/v1/tenants/:tenant_id/participants/:participant_id/access-grants", http_status: 200, method: "POST", participant_id: PT_HOST, tenant_id: TENANT, event: "http.request" }),
        fact("http.request", T0 + 30_000, { http_route: "/v1/participants/:participant_id/episode", http_status: 200, method: "GET", participant_id: PT_GUEST, event: "http.request" }),
        fact("sync.websocket.authenticated", T0 + 1000, { participant_id_hash: "h_other", participant_id: "99999999-0000-4000-8000-000000000077", event: "sync.websocket.authenticated" }),
      ],
    },
  },
  "admission.unanswered": {
    description: "The guest's knock expired while a host was authenticated and positioned, but the host's dashboard never showed the knock and nothing was decided.",
    asof_ms: T0 + HOUR,
    declaration: episode([seat(PT_GUEST, "guest", { kind: /** @type {const} */ ("guest"), device: "dev_g", name: "Spec" }), seat(PT_HOST, "host", { kind: /** @type {const} */ ("user"), id: USR_HOST, name: "Host", tenant: TENANT })]),
    expect: { hop: "knock_notice", outcome: "broken" },
    pg: {
      seed: `insert into tenants values('${TENANT}','Spec'); insert into spaces(id,name,tenant_id,slug,media_plane,updated_at) values('${SPACE}','spec','${TENANT}','spec-space','sfu','${iso(T0 - 9000)}'); insert into episodes(id,status,space_id,tenant_id,config_snapshot) values('${EP}','active','${SPACE}','${TENANT}','{}'); insert into participants(id,capabilities,tenant_id,space_id,episode_id,generation,status,role,joined_at) values('${PT_HOST}','{manageAdmission}','${TENANT}','${SPACE}','${EP}',1,'active','host','${iso(T0 - 7000)}'); insert into space_public_invites(tenant_id,space_id,handle,admission_mode) values('${TENANT}','${SPACE}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),'knock'); insert into space_public_arrivals(arrival_handle,tenant_id,space_id,invite_handle,invite_generation,invite_state_epoch,identity_mode,display_name,guest_credential_hash,idempotency_key,idempotency_fingerprint,state,expires_at,created_at) values('${ARR}','${TENANT}','${SPACE}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),1,1,'guest','Spec',decode('1111111111111111111111111111111111111111111111111111111111111111','hex'),'idem1',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),'pending','${iso(T0 + 3_600_000)}','${iso(T0)}'); insert into space_public_admission_requests(request_handle,arrival_handle,tenant_id,space_id,display_name,state,requested_at,expires_at) values('${REQ}','${ARR}','${TENANT}','${SPACE}','Spec','expired','${iso(T0 + 5000)}','${iso(T0 + 305_000)}'); `,
      select: `select jsonb_build_object('kind','fact','name','admission.db.request','event_id','db:req:'||left(request_handle::text,8),'est_server_ms',(extract(epoch from requested_at)*1000)::bigint,'admission_status',state,'requested_at',(extract(epoch from requested_at)*1000)::bigint,'expires_at',(extract(epoch from expires_at)*1000)::bigint,'decided_at',null,'decided_by',null,'arrival_handle',arrival_handle,'admission_request_id',request_handle,'space_id',space_id,'tenant_id',tenant_id) from space_public_admission_requests union all select jsonb_build_object('kind','fact','name','admission.db.participant','event_id','db:pt:'||left(id::text,8),'est_server_ms',${T0 + 4000},'participant_status',status,'manage_admission',(capabilities @> '{manageAdmission}'),'joined_at',(extract(epoch from joined_at)*1000)::bigint,'participant_id',id,'episode_id',episode_id) from participants`,
    },
    positive: {
      rows: [
        fact("sync.admission_requested", T0 + 5000, { admission_request_id: REQ, participant_id: PT_GUEST, event: "admission_requested" }),
        fact("admission.db.sync_request", T0 + 5000, { admission_status: "expired", requested_at: T0 + 5000, expires_at: T0 + 305_000, decided_at: null, admission_request_id: REQ, participant_id: PT_GUEST }),
        fact("sync.websocket.authenticated", T0 + 1000, { participant_id_hash: "h_host", participant_id: PT_HOST, event: "sync.websocket.authenticated" }),
        fact("dashboard.call_page", T0 + 10_000, { surface_state: "shown", shown_ms: T0 + 10_000, space_id: SPACE, user_id: USR_HOST, client_session_id: CS_OTHER }),
        fact("edge.call_status", T0 + 10_000, { http_status: 200, space_id: SPACE, user_id: USR_HOST }),
        fact("admission.knock_notice", T0 + 20_000, { surface_state: "dismissed", shown_ms: 0, admission_request_id: "99999999-0000-4000-8000-000000000099", participant_id: PT_HOST, client_session_id: CS_OTHER }),
        fact("dashboard.knocks", T0 + 20_000, { surface_state: "dismissed", shown_ms: 0, space_id: SPACE, user_id: USR_HOST, participant_id: PT_HOST, client_session_id: CS_OTHER }),
        fact("admission.decide", T0 + 21_000, { outcome: "ok", reason_code: "", duration_ms: 50, admission_request_id: "99999999-0000-4000-8000-000000000099", participant_id: PT_HOST, client_session_id: CS_OTHER }),
      ],
    },
    healthy_pg: {
      seed: `insert into tenants values('${TENANT}','Spec'); insert into spaces(id,name,tenant_id,slug,media_plane,updated_at) values('${SPACE}','spec','${TENANT}','spec-space','sfu','${iso(T0 - 9000)}'); insert into episodes(id,status,space_id,tenant_id,config_snapshot) values('${EP}','active','${SPACE}','${TENANT}','{}'); insert into users(id,name,email) values('${USR_HOST}','Spec','spec@example.invalid'); insert into participants(id,capabilities,tenant_id,space_id,episode_id,generation,status,role,joined_at) values('${PT_HOST}','{manageAdmission}','${TENANT}','${SPACE}','${EP}',1,'active','host','${iso(T0 - 7000)}'); insert into space_public_invites(tenant_id,space_id,handle,admission_mode) values('${TENANT}','${SPACE}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),'knock'); insert into space_public_arrivals(arrival_handle,tenant_id,space_id,invite_handle,invite_generation,invite_state_epoch,identity_mode,display_name,guest_credential_hash,idempotency_key,idempotency_fingerprint,state,expires_at,created_at) values('${ARR}','${TENANT}','${SPACE}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),1,1,'guest','Spec',decode('1111111111111111111111111111111111111111111111111111111111111111','hex'),'idem1',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),'pending','${iso(T0 + 3_600_000)}','${iso(T0)}'); insert into space_public_admission_requests(request_handle,arrival_handle,tenant_id,space_id,display_name,state,requested_at,expires_at,decided_at,decided_by) values('${REQ}','${ARR}','${TENANT}','${SPACE}','Spec','approved','${iso(T0 + 5000)}','${iso(T0 + 305_000)}','${iso(T0 + 12_000)}','${USR_HOST}'); `,
      select: `select jsonb_build_object('kind','fact','name','admission.db.request','event_id','db:req:'||left(request_handle::text,8),'est_server_ms',(extract(epoch from requested_at)*1000)::bigint,'admission_status',state,'requested_at',(extract(epoch from requested_at)*1000)::bigint,'expires_at',(extract(epoch from expires_at)*1000)::bigint,'decided_at',(extract(epoch from decided_at)*1000)::bigint,'decided_by',decided_by,'arrival_handle',arrival_handle,'admission_request_id',request_handle,'space_id',space_id,'tenant_id',tenant_id) from space_public_admission_requests union all select jsonb_build_object('kind','fact','name','admission.db.participant','event_id','db:pt:'||left(id::text,8),'est_server_ms',${T0 + 4000},'participant_status',status,'manage_admission',(capabilities @> '{manageAdmission}'),'joined_at',(extract(epoch from joined_at)*1000)::bigint,'participant_id',id,'episode_id',episode_id) from participants`,
    },
    healthy: {
      rows: [
        fact("sync.admission_requested", T0 + 5000, { admission_request_id: REQ, participant_id: PT_GUEST, event: "admission_requested" }),
        fact("admission.db.sync_request", T0 + 5000, { admission_status: "admitted", requested_at: T0 + 5000, expires_at: T0 + 305_000, decided_at: T0 + 21_000, admission_request_id: REQ, participant_id: PT_GUEST }),
        fact("sync.websocket.authenticated", T0 + 1000, { participant_id_hash: "h_host", participant_id: PT_HOST, event: "sync.websocket.authenticated" }),
        fact("dashboard.call_page", T0 + 10_000, { surface_state: "shown", shown_ms: T0 + 10_000, space_id: SPACE, user_id: USR_HOST, client_session_id: CS_HOST }),
        fact("edge.call_status", T0 + 10_000, { http_status: 200, space_id: SPACE, user_id: USR_HOST }),
        fact("admission.knock_notice", T0 + 8000, { surface_state: "shown", shown_ms: T0 + 8000, admission_request_id: REQ, participant_id: PT_HOST, client_session_id: CS_HOST }),
        fact("dashboard.knocks", T0 + 11_000, { surface_state: "shown", shown_ms: T0 + 11_000, space_id: SPACE, user_id: USR_HOST, client_session_id: CS_HOST }),
        fact("admission.decide", T0 + 21_000, { outcome: "ok", reason_code: "", duration_ms: 50, admission_request_id: REQ, participant_id: PT_HOST, client_session_id: CS_HOST }),
      ],
    },
  },
  "admission.not_collected": {
    description: "The host approved the arrival and it went terminal, but the guest's waiting page kept polling until it left: the approval was never collected.",
    asof_ms: T0 + HOUR,
    declaration: episode([seat(PT_GUEST, "guest", { kind: /** @type {const} */ ("guest"), device: "dev_g", name: "Spec" }), seat(PT_HOST, "host", { kind: /** @type {const} */ ("user"), id: USR_HOST, name: "Host", tenant: TENANT })]),
    expect: { hop: "client_network", outcome: "broken" },
    pg: {
      seed: `insert into tenants values('${TENANT}','Spec'); insert into spaces(id,name,tenant_id,slug,media_plane,updated_at) values('${SPACE}','spec','${TENANT}','spec-space','sfu','${iso(T0 - 9000)}'); insert into episodes(id,status,space_id,tenant_id,config_snapshot) values('${EP}','active','${SPACE}','${TENANT}','{}'); insert into participants(id,capabilities,tenant_id,space_id,episode_id,generation,status,role) values('${PT_GUEST}','{publishAudio}','${TENANT}','${SPACE}','${EP}',1,'active','guest'); insert into space_public_invites(tenant_id,space_id,handle,admission_mode) values('${TENANT}','${SPACE}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),'knock'); insert into space_public_arrivals(arrival_handle,tenant_id,space_id,invite_handle,invite_generation,invite_state_epoch,identity_mode,display_name,guest_credential_hash,idempotency_key,idempotency_fingerprint,state,expires_at,terminal_reason,created_at,terminal_at,episode_id,participant_id,participant_generation,provider,provider_subject) values('${ARR}','${TENANT}','${SPACE}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),1,1,'guest','Spec',decode('1111111111111111111111111111111111111111111111111111111111111111','hex'),'idem1',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),'left','${iso(T0 + 3_600_000)}','admission_not_collected','${iso(T0 + 4000)}','${iso(T0 + 30_000)}','${EP}','${PT_GUEST}',1,'sfu','subj');`,
      select: `select jsonb_build_object('kind','fact','name','admission.db.arrival','event_id','db:arr:'||left(arrival_handle::text,8),'est_server_ms',(extract(epoch from terminal_at)*1000)::bigint,'terminal_reason',coalesce(terminal_reason,'none'),'arrival_state',state,'completed_at',(extract(epoch from terminal_at)*1000)::bigint,'invite_generation',invite_generation,'created_at',(extract(epoch from created_at)*1000)::bigint,'arrival_handle',arrival_handle,'space_id',space_id,'tenant_id',tenant_id,'client_session_id','cs_spec_fault') from space_public_arrivals union all select jsonb_build_object('kind','fact','name','invite.db.membership','event_id','db:mb:1','est_server_ms',${T0 + 4000},'created_at',(extract(epoch from created_at)*1000)::bigint,'user_id',user_id,'tenant_id',tenant_id,'client_session_id','cs_spec_fault') from memberships`,
    },
    positive: {
      rows: [
        fact("admission.sweep", T0 + 30_000, { completed_at: T0 + 30_000, arrival_handle: ARR }),
        fact("public_invite.request", T0 + 10_000, { operation: "status", http_status: 200, arrival_handle: ARR, client_session_id: CS, event: "public_invite.request" }),
        fact("admission.status_poll", T0 + 10_000, { arrival_handle: ARR, client_session_id: CS }),
        fact("admission.pagehide", T0 + 50_000, { phase: "admitted", arrival_handle: ARR, client_session_id: CS_OTHER }),
      ],
    },
    healthy_pg: {
      seed: `insert into tenants values('${TENANT}','Spec'); insert into spaces(id,name,tenant_id,slug,media_plane,updated_at) values('${SPACE}','spec','${TENANT}','spec-space','sfu','${iso(T0 - 9000)}'); insert into episodes(id,status,space_id,tenant_id,config_snapshot) values('${EP}','active','${SPACE}','${TENANT}','{}'); insert into participants(id,capabilities,tenant_id,space_id,episode_id,generation,status,role) values('${PT_GUEST}','{publishAudio}','${TENANT}','${SPACE}','${EP}',1,'active','guest'); insert into space_public_invites(tenant_id,space_id,handle,admission_mode) values('${TENANT}','${SPACE}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),'knock'); insert into space_public_arrivals(arrival_handle,tenant_id,space_id,invite_handle,invite_generation,invite_state_epoch,identity_mode,display_name,guest_credential_hash,idempotency_key,idempotency_fingerprint,state,expires_at,terminal_reason,created_at,terminal_at,episode_id,participant_id,participant_generation,provider,provider_subject) values('${ARR}','${TENANT}','${SPACE}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),1,1,'guest','Spec',decode('1111111111111111111111111111111111111111111111111111111111111111','hex'),'idem1',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),'admitted','${iso(T0 + 3_600_000)}','admitted','${iso(T0 + 4000)}','${iso(T0 + 30_000)}','${EP}','${PT_GUEST}',1,'sfu','subj');`,
      select: `select jsonb_build_object('kind','fact','name','admission.db.arrival','event_id','db:arr:'||left(arrival_handle::text,8),'est_server_ms',(extract(epoch from terminal_at)*1000)::bigint,'terminal_reason',coalesce(terminal_reason,'none'),'arrival_state',state,'completed_at',(extract(epoch from terminal_at)*1000)::bigint,'invite_generation',invite_generation,'created_at',(extract(epoch from created_at)*1000)::bigint,'arrival_handle',arrival_handle,'space_id',space_id,'tenant_id',tenant_id) from space_public_arrivals`,
    },
    healthy: {
      rows: [
        fact("admission.sweep", T0 + 30_000, { completed_at: T0 + 30_000, arrival_handle: ARR }),
        fact("public_invite.request", T0 + 10_000, { operation: "status", http_status: 200, arrival_handle: ARR, client_session_id: CS, event: "public_invite.request" }),
        fact("public_invite.request", T0 + 29_000, { operation: "status", http_status: 200, arrival_handle: ARR, client_session_id: CS, event: "public_invite.request" }),
        fact("admission.status_poll", T0 + 10_000, { arrival_handle: ARR, client_session_id: CS }),
        fact("admission.status_poll", T0 + 29_000, { arrival_handle: ARR, client_session_id: CS }),
        fact("admission.pagehide", T0 + 31_000, { phase: "admitted", arrival_handle: ARR, client_session_id: CS }),
      ],
    },
  },
};
