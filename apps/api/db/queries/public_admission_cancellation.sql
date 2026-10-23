-- name: RecordPublicAdmissionCancellation :exec
insert into observability_journey_events (
    event_id, journey_id, sequence, occurred_at, name, phase, state,
    origin_kind, first_observed_layer, upstream_visibility, trace_id, span_id, attributes
) values (
    sqlc.arg(event_id), sqlc.arg(journey_id), 0, now(), 'participant.admission_cancelled',
    'terminal', 'cancelled', 'server', 'api', 'visible', sqlc.narg(trace_id), sqlc.narg(span_id),
    jsonb_build_object('tenant_id', sqlc.arg(tenant_id)::uuid, 'space_id', sqlc.arg(space_id)::uuid,
                       'arrival_handle', sqlc.arg(arrival_handle)::uuid, 'reason', 'cancelled')
);
