-- +goose Up

create table feedback_reports (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete restrict,
    category text not null check (category in ('bug', 'feature_request', 'other')),
    source text not null check (source in ('embedded', 'chalk_web', 'chalk_mobile', 'dashboard')),
    message text not null check (octet_length(message) between 1 and 8000),
    submitter_kind text not null check (submitter_kind in ('account', 'participant')),
    submitter_id text not null check (char_length(submitter_id) between 1 and 256),
    user_id uuid references users(id) on delete restrict,
    space_id uuid,
    episode_id uuid,
    participant_id uuid,
    environment text,
    audience text,
    diagnostic_reference text,
    journey_id uuid,
    root_journey_id uuid,
    trace_id text,
    span_id text,
    request_id text,
    command_id text,
    submission_journey_id uuid,
    submission_trace_id text,
    submission_span_id text,
    idempotency_key text not null check (char_length(idempotency_key) between 16 and 128 and idempotency_key ~ '^[A-Za-z0-9_-]+$'),
    request_digest bytea not null check (octet_length(request_digest) = 32),
    evidence_object_key text not null,
    evidence_content_type text not null default 'application/json',
    evidence_size bigint not null check (evidence_size > 0 and evidence_size <= 131072),
    evidence_sha256 bytea not null check (octet_length(evidence_sha256) = 32),
    evidence_schema_version text not null check (evidence_schema_version = 'FeedbackEvidence/v1'),
    screenshot_object_key text,
    screenshot_content_type text,
    screenshot_size bigint,
    screenshot_sha256 bytea,
    screenshot_width integer,
    screenshot_height integer,
    screenshot_captured_at timestamptz,
    screenshot_failure_code text,
    created_at timestamptz not null default now(),
    submitted_at timestamptz not null default now(),
    constraint feedback_reports_screenshot_metadata_check check (
        (screenshot_object_key is null and screenshot_content_type is null and screenshot_size is null and screenshot_sha256 is null and screenshot_width is null and screenshot_height is null and screenshot_captured_at is null)
        or (screenshot_object_key is not null and screenshot_content_type in ('image/jpeg', 'image/png', 'image/webp') and screenshot_size > 0 and screenshot_size <= 460800 and screenshot_sha256 is not null and octet_length(screenshot_sha256) = 32 and screenshot_width between 1 and 1920 and screenshot_height between 1 and 1080 and screenshot_captured_at is not null)
    ),
    constraint feedback_reports_screenshot_failure_code_check check (screenshot_failure_code is null or screenshot_failure_code in ('capture_failed', 'unsupported', 'tainted', 'secure_surface', 'too_large')),
    constraint feedback_reports_trace_id_check check (trace_id is null or trace_id ~ '^[0-9a-f]{32}$'),
    constraint feedback_reports_span_id_check check (span_id is null or span_id ~ '^[0-9a-f]{16}$'),
    constraint feedback_reports_submission_trace_id_check check (submission_trace_id is null or submission_trace_id ~ '^[0-9a-f]{32}$'),
    constraint feedback_reports_submission_span_id_check check (submission_span_id is null or submission_span_id ~ '^[0-9a-f]{16}$')
);

create unique index feedback_reports_submitter_idempotency_idx
    on feedback_reports(tenant_id, submitter_kind, submitter_id, idempotency_key);
create index feedback_reports_operator_created_idx
    on feedback_reports(created_at desc, id desc);
create index feedback_reports_tenant_created_idx
    on feedback_reports(tenant_id, created_at desc, id desc);
create index feedback_reports_category_source_idx
    on feedback_reports(category, source, created_at desc, id desc);

-- +goose Down

drop table if exists feedback_reports;
