-- Feedback reports are tenant-bound for customer writes and operator-scoped
-- for reads. Object bytes remain in object storage.

-- name: GetFeedbackReportByIdempotency :one
select *
from feedback_reports
where tenant_id = sqlc.arg(tenant_id)
  and submitter_kind = sqlc.arg(submitter_kind)
  and submitter_id = sqlc.arg(submitter_id)
  and idempotency_key = sqlc.arg(idempotency_key);

-- name: InsertFeedbackReport :one
insert into feedback_reports (
    id, tenant_id, category, source, message, submitter_kind, submitter_id,
    user_id, space_id, episode_id, participant_id, environment, audience,
    diagnostic_reference, journey_id, root_journey_id, trace_id, span_id,
    request_id, command_id, submission_journey_id, submission_trace_id,
    submission_span_id, idempotency_key, request_digest, evidence_object_key,
    evidence_content_type, evidence_size, evidence_sha256, evidence_schema_version,
    screenshot_object_key, screenshot_content_type, screenshot_size,
    screenshot_sha256, screenshot_width, screenshot_height, screenshot_captured_at,
    screenshot_failure_code, created_at, submitted_at
) values (
    sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(category), sqlc.arg(source),
    sqlc.arg(message), sqlc.arg(submitter_kind), sqlc.arg(submitter_id),
    sqlc.narg(user_id), sqlc.narg(space_id), sqlc.narg(episode_id),
    sqlc.narg(participant_id), sqlc.narg(environment), sqlc.narg(audience),
    sqlc.narg(diagnostic_reference), sqlc.narg(journey_id), sqlc.narg(root_journey_id),
    sqlc.narg(trace_id), sqlc.narg(span_id), sqlc.narg(request_id), sqlc.narg(command_id),
    sqlc.narg(submission_journey_id), sqlc.narg(submission_trace_id), sqlc.narg(submission_span_id),
    sqlc.arg(idempotency_key), sqlc.arg(request_digest), sqlc.arg(evidence_object_key),
    sqlc.arg(evidence_content_type), sqlc.arg(evidence_size), sqlc.arg(evidence_sha256),
    sqlc.arg(evidence_schema_version), sqlc.narg(screenshot_object_key),
    sqlc.narg(screenshot_content_type), sqlc.narg(screenshot_size), sqlc.narg(screenshot_sha256),
    sqlc.narg(screenshot_width), sqlc.narg(screenshot_height), sqlc.narg(screenshot_captured_at),
    sqlc.narg(screenshot_failure_code), sqlc.arg(created_at), sqlc.arg(submitted_at)
)
returning *;

-- name: GetFeedbackReport :one
select *
from feedback_reports
where tenant_id = sqlc.arg(tenant_id)
  and id = sqlc.arg(id);

-- name: GetFeedbackReportForOperator :one
select *
from feedback_reports
where id = sqlc.arg(id);

-- name: ListFeedbackReports :many
select *
from feedback_reports
where (sqlc.narg(category)::text is null or category = sqlc.narg(category)::text)
  and (sqlc.narg(source)::text is null or source = sqlc.narg(source)::text)
  and (sqlc.narg(tenant_id)::uuid is null or tenant_id = sqlc.narg(tenant_id)::uuid)
  and (sqlc.narg(from_time)::timestamptz is null or created_at >= sqlc.narg(from_time)::timestamptz)
  and (sqlc.narg(to_time)::timestamptz is null or created_at < sqlc.narg(to_time)::timestamptz)
  and (
      sqlc.narg(cursor_created_at)::timestamptz is null
      or (created_at, id) < (sqlc.narg(cursor_created_at)::timestamptz, sqlc.narg(cursor_id)::uuid)
  )
order by created_at desc, id desc
limit sqlc.arg(page_limit);
