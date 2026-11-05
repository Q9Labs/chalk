"""Synthetic fixture, cloned into a fresh tenant for every trial (no external data)."""

import base64
import hashlib
import json
import secrets
import subprocess
import uuid
from urllib.parse import urlparse

SCOPES = [
    "tenants:read", "memberships:read", "memberships:write", "api_keys:read",
    "api_keys:write", "api_keys:delete", "webhooks:read", "webhooks:write",
    "webhooks:delete", "spaces:read", "spaces:write", "episodes:read",
    "episodes:write", "recordings:read", "transcriptions:read", "transcriptions:delete",
]
NAMESPACE = uuid.UUID("4bdf8332-cb27-4db6-9134-03c485176c86")
SNAPSHOT = {
    "roles": {"collaborator": ["sendChat"]}, "admission_policy": {"mode": "open"},
    "default_episode_duration_seconds": 86400, "maximum_episode_duration_seconds": 86400,
    "linger_window_seconds": 0,
    "artifact_policy": {
        "schema_version": "episode_config.v2",
        "recording": {"mode": "manual", "profile": "composite_720p_v1", "retention_seconds": 2592000},
        "transcription": {"mode": "on_demand", "provider_policy_version": "eval-v1", "retention_seconds": 2592000, "source_window_seconds": 2592000},
    },
}


def quote(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        value = json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "ARRAY[" + ",".join(quote(item) for item in value) + "]::text[]"
    return "'" + str(value).replace("'", "''") + "'"


class Database:
    def __init__(self, url):
        parsed = urlparse(url)
        if parsed.hostname not in ("localhost", "127.0.0.1") or parsed.path != "/chalk_mcp_eval":
            raise ValueError("Only loopback /chalk_mcp_eval is allowed; use an SSH forward")
        self.url = url
        if self.query("select id from mcp_eval_marker where id") != "t":
            raise ValueError("Eval database marker missing")

    def query(self, sql):
        result = subprocess.run(
            ["psql", self.url, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
            input=sql, text=True, capture_output=True, timeout=45,
        )
        if result.returncode:
            # SQL may contain a credential. Do not include command or input in errors.
            message = next((line for line in result.stderr.splitlines() if line.startswith("ERROR:")), "psql failed")
            raise RuntimeError("Fixture SQL failed: " + message)
        return result.stdout.strip()

    def reset(self):
        self.query("""
        begin;
        set local session_replication_role = replica;
        do $$ declare tables text; begin
          select string_agg(format('%I', tablename), ',') into tables from pg_tables
          where schemaname='public' and tablename not in ('goose_db_version','mcp_eval_marker');
          if tables is not null then execute 'truncate ' || tables || ' restart identity cascade'; end if;
        end $$;
        commit;
        create table if not exists mcp_eval_objects (
          tenant_id uuid not null, object_key text primary key, body jsonb not null
        );
        """)


def seed(db, label):
    def identifier(name):
        digest = hashlib.sha256(NAMESPACE.bytes + (label + ":" + name).encode()).digest()
        # Webhook event contracts require v4-shaped resource IDs, including tenant.
        return str(uuid.UUID(bytes=digest[:16], version=4))

    statements = []

    def insert(table, **values):
        statements.append(f"insert into {table} ({','.join(values)}) values ({','.join(quote(v) for v in values.values())});")

    tenant = identifier("tenant")
    insert("tenants", id=tenant, name="MCP Evaluation", default_region="ap-south")
    insert("tenant_artifact_policies", tenant_id=tenant)
    prefix = base64.urlsafe_b64encode(secrets.token_bytes(9)).decode().rstrip("=")
    raw = "chalk_sk_" + prefix + "." + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    insert("api_keys", id=identifier("runner-key"), tenant_id=tenant, name="Evaluation runner",
           key_hash=hashlib.sha256(raw.encode()).hexdigest(), key_prefix=prefix,
           scopes=SCOPES, expires_at="2099-01-01T00:00:00Z")
    rotate_prefix = base64.urlsafe_b64encode(secrets.token_bytes(9)).decode().rstrip("=")
    rotate_raw = "chalk_sk_" + rotate_prefix + "." + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    rotate_hash = hashlib.sha256(rotate_raw.encode()).hexdigest()
    insert("api_keys", id=identifier("rotate-key"), tenant_id=tenant, name="Automation key",
           key_hash=rotate_hash, key_prefix=rotate_prefix,
           scopes=["spaces:read"], expires_at="2099-01-01T00:00:00Z")
    for name, role in [("Amina", "owner"), ("Bilal", "collaborator"), ("Chen", "observer")]:
        insert("users", id=identifier(name), name=name, email=f"{name.lower()}-{tenant}@example.invalid")
        insert("memberships", id=identifier("member-" + name), tenant_id=tenant, user_id=identifier(name), role=role)
    spaces = {}
    for name in ["Atlas", "Beacon", "Commons", "Retired"]:
        spaces[name] = identifier(name)
        insert("spaces", id=spaces[name], tenant_id=tenant, name=name, slug=name.lower(),
               media_plane="cf_sfu", recording_policy="manual", transcription_policy="on_demand",
               archived_at="2026-10-18T00:00:00Z" if name == "Retired" else None)
        insert("space_roles", id=identifier("role-" + name), tenant_id=tenant, space_id=spaces[name],
               name="collaborator", capabilities=["sendChat"])
    episodes = []
    for number in range(8):
        space = "Atlas" if number < 4 else "Beacon" if number < 7 else "Commons"
        live = number in (3, 7)
        episode = identifier(f"episode-{number}")
        episodes.append(episode)
        day = 19 + number if number < 6 else 25
        started = f"2026-10-{day:02}T10:00:00Z"
        insert("episodes", id=episode, tenant_id=tenant, space_id=spaces[space], status="active" if live else "ended",
               config_snapshot=SNAPSHOT, created_at=started, started_at=started,
               ended_at=None if live else f"2026-10-{day:02}T11:00:00Z", end_reason=None if live else "explicit",
               deadline_at="2099-01-01T00:00:00Z")
        names = ["Amina"] if number in (0, 1, 2, 4, 5) else []
        if number in (0, 1, 4, 6):
            names.append("Bilal")
        if number in (0, 2):
            names.append("Chen")
        if live:
            names = ["Dara"]
        for name in names:
            insert("participants", id=identifier(f"{number}-{name}"), tenant_id=tenant,
                   space_id=spaces[space], episode_id=episode, name=name,
                   account_id=identifier(name) if name != "Dara" else None,
                   generation=1, status="active" if live else "left", role="collaborator", capabilities=["sendChat"],
                   joined_at=started, left_at=None if live else f"2026-10-{day:02}T10:45:00Z")
    # Pending admissions need only the durable authority shell for read-only inspection.
    insert("sync_episode_control", tenant_id=tenant, space_id=spaces["Atlas"], episode_id=episodes[3],
           folded_state={}, state_schema_version=1, state_digest="\\x" + "00" * 32, snapshot_bytes=2)
    insert("sync_admission_requests", tenant_id=tenant, space_id=spaces["Atlas"], episode_id=episodes[3],
           admission_request_id=identifier("admission"), request_key="eval-admission-000001",
           request_fingerprint="\\x" + "00" * 32, participant_id=identifier("waiting"),
           display_name="Esha", role="collaborator", expires_at="2099-01-01T00:00:00Z")
    handle = "\\x" + hashlib.sha256((tenant + ":invite").encode()).hexdigest()
    insert("space_public_invites", tenant_id=tenant, space_id=spaces["Atlas"], handle=handle,
           admission_mode="knock")
    insert("space_public_arrivals", arrival_handle=identifier("arrival"), tenant_id=tenant, space_id=spaces["Atlas"],
           invite_handle=handle, invite_generation=1, invite_state_epoch=1, identity_mode="guest", display_name="Esha",
           guest_credential_hash="\\x" + "00" * 32, idempotency_key="eval-arrival-000001",
           idempotency_fingerprint="\\x" + "00" * 32, state="pending", expires_at="2099-01-01T00:00:00Z")
    insert("space_public_admission_requests", request_handle=identifier("admission"), arrival_handle=identifier("arrival"),
           tenant_id=tenant, space_id=spaces["Atlas"], display_name="Esha", state="pending", expires_at="2099-01-01T00:00:00Z")
    languages = [["en"], ["ur"], ["ar"], ["en", "ur", "ar"]]
    text = ["Please review invoicing on Tuesday.", "انوائسنگ کی رپورٹ منگل کو بھیجیں۔",
            "يرجى إرسال الفاتورة يوم الثلاثاء.", "Invoice ready. رسید بھیجیں۔ أرسل الفاتورة."]
    recordings = []
    for number in range(4):
        recording = identifier(f"recording-{number}")
        transcript = identifier(f"transcript-{number}")
        recordings.append(recording)
        key = f"tenants/{tenant}/recordings/{recording}.mp4"
        insert("recordings", id=recording, tenant_id=tenant, space_id=spaces["Atlas"], episode_id=episodes[number],
               status="completed", storage_provider="r2", storage_key=key if number != 1 else None, duration_millis=3600000)
        insert("recording_reservations", id=identifier(f"reservation-{number}"), tenant_id=tenant,
               space_id=spaces["Atlas"], episode_id=episodes[number], recording_id=recording,
               idempotency_key="reservation:" + recording, request_fingerprint="\\x" + "00" * 32,
               policy_snapshot_version="episode_config.v2", participant_count=1, max_duration_seconds=3600,
               input_bitrate_bps=100000, state="released", ends_at="2026-10-26T00:00:00Z")
        insert("recording_pipelines", recording_id=recording, tenant_id=tenant,
               reservation_id=identifier(f"reservation-{number}"), state="capture_complete", capture_completed_at="now")
        job = identifier(f"render-{number}")
        insert("recording_jobs", id=job, tenant_id=tenant, episode_id=episodes[number], recording_id=recording,
               kind="render", idempotency_key="render:" + recording, payload_schema_version=1,
               state="succeeded" if number != 1 else "terminal_failure", attempt_limit=3,
               error_code="eval_render_failed" if number == 1 else None,
               terminal_at="2026-10-26T00:00:00Z", available_at="2099-01-01T00:00:00Z")
        if number != 1:
            insert("recording_artifacts", recording_id=recording, tenant_id=tenant, render_job_id=job,
                   object_key=key, content_type="video/mp4", byte_size=1, checksum="\\x" + "00" * 32,
                   duration_millis=3600000, committed_at="2026-10-26T00:00:00Z", expires_at="2099-01-01T00:00:00Z")
        artifact = f"tenants/{tenant}/transcripts/{transcript}.json"
        segments = [{"speaker": "Amina", "start_ms": 12000, "text": text[number]}]
        if number == 3:
            segments = [{"speaker": "Bilal", "start_ms": i * 1000, "text": "Routine update."} for i in range(4500)]
            segments[0] = {"speaker": "Amina", "start_ms": 0, "text": text[number]}
            segments[4100] = {"speaker": "Amina", "start_ms": 4100000, "text": "The invoice approval code is ORCHID-73."}
        body = {"segments": segments}
        encoded = json.dumps(body, ensure_ascii=False).encode()
        insert("mcp_eval_objects", tenant_id=tenant, object_key=artifact, body=body)
        insert("transcriptions", id=transcript, tenant_id=tenant, recording_id=recording, space_id=spaces["Atlas"],
               episode_id=episodes[number], status="complete", languages=languages[number], artifact_key=artifact,
               artifact_content_type="application/json", artifact_size=len(encoded),
               artifact_sha256="\\x" + hashlib.sha256(encoded).hexdigest(), completed_at="2026-10-26T00:00:00Z")
    # Listing/history never decrypt these inert fixture secrets or send network traffic.
    endpoint, revision, event = identifier("webhook"), identifier("webhook-revision"), identifier("event")
    insert("webhook_endpoints", id=endpoint, tenant_id=tenant, name="Fixture archive", enabled=False,
           revision=1, current_target_revision=1, current_secret_ciphertext="\\x00")
    insert("webhook_endpoint_revisions", id=revision, tenant_id=tenant, endpoint_id=endpoint, revision=1,
           url_ciphertext="\\x00", url_redacted="https://example.invalid/fixture", api_version=1, event_types=["episode.ended"])
    insert("webhook_events", id=event, tenant_id=tenant, event_name="episode.ended", api_version=1,
           occurred_at="2026-10-26T00:00:00Z", body="\\x7b7d", body_sha256="\\x" + "00" * 32,
           semantic_transition_key="eval-event", resource_type="episode", resource_id=episodes[0], journey_id=identifier("journey"))
    for state in ("succeeded", "exhausted"):
        if state == "exhausted":
            insert("webhook_events", id=identifier("event-failed"), tenant_id=tenant, event_name="episode.ended", api_version=1,
                   occurred_at="2026-10-26T00:00:00Z", body="\\x7b7d", body_sha256="\\x" + "00" * 32,
                   semantic_transition_key="eval-event-failed", resource_type="episode", resource_id=episodes[1], journey_id=identifier("journey-failed"))
        insert("webhook_deliveries", id=identifier("delivery-" + state), tenant_id=tenant,
               event_id=event if state == "succeeded" else identifier("event-failed"),
               endpoint_id=endpoint, endpoint_revision_id=revision, endpoint_revision=1, state=state,
               attempt_count=1, terminal_at="2026-10-26T00:00:00Z", queued_journey_event_id=identifier("queue-" + state),
               terminal_journey_event_id=identifier("terminal-" + state))
    db.query("begin;\n" + "\n".join(statements) + "\ncommit;")
    return {"tenant": tenant, "key": raw, "spaces": spaces, "episodes": episodes,
            "recordings": recordings, "rotate_key": identifier("rotate-key"),
            "rotate_key_hash": rotate_hash, "rotate_key_prefix": rotate_prefix, "webhook": endpoint}
