-- +goose Up
create index diagnostic_events_plain_trace_idx
    on diagnostic_events(trace_id, tenant_id, diagnostic_id)
    where trace_id is not null;

create index diagnostic_operations_plain_trace_idx
    on diagnostic_operations(trace_id, tenant_id, diagnostic_id)
    where trace_id is not null;

-- +goose Down
drop index if exists diagnostic_operations_plain_trace_idx;
drop index if exists diagnostic_events_plain_trace_idx;
