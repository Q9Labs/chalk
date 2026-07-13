-- name: InsertJourneyEvent :one
insert into observability_journey_events (
    event_id,
    journey_id,
    sequence,
    occurred_at,
    name,
    phase,
    state,
    origin_kind,
    first_observed_layer,
    upstream_visibility,
    parent_event_id,
    trace_id,
    span_id,
    attributes
) values (
    sqlc.arg(event_id),
    sqlc.arg(journey_id),
    sqlc.arg(sequence),
    sqlc.arg(occurred_at),
    sqlc.arg(name),
    sqlc.arg(phase),
    sqlc.arg(state),
    sqlc.arg(origin_kind),
    sqlc.arg(first_observed_layer),
    sqlc.arg(upstream_visibility),
    sqlc.narg(parent_event_id),
    sqlc.narg(trace_id),
    sqlc.narg(span_id),
    sqlc.arg(attributes)
)
on conflict (event_id) do nothing
returning event_id;

-- name: ListJourneyEvents :many
select
    event_id,
    journey_id,
    sequence,
    occurred_at,
    received_at,
    name,
    phase,
    state,
    origin_kind,
    first_observed_layer,
    upstream_visibility,
    parent_event_id,
    trace_id,
    span_id,
    attributes
from observability_journey_events
where journey_id = sqlc.arg(journey_id)
order by sequence asc, occurred_at asc, event_id asc;

-- name: GetJourneyTerminalState :one
select state
from observability_journey_events
where
    journey_id = sqlc.arg(journey_id)
    and phase = 'terminal'
    and state in ('completed', 'succeeded', 'failed', 'cancelled', 'canceled', 'exhausted', 'erased')
    and name not like 'webhook.delivery.%'
order by sequence desc, occurred_at desc, event_id desc
limit 1;
