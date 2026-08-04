-- +goose Up
alter table sync_external_operations
    add column producing_traceparent text,
    add column producing_tracestate text;

alter table sync_external_operations
    add constraint sync_external_operations_producing_traceparent_check
        check (
            producing_traceparent is null
            or producing_traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
        ),
    add constraint sync_external_operations_producing_tracestate_check
        check (
            producing_tracestate is null
            or octet_length(producing_tracestate) between 1 and 512
        ),
    add constraint sync_external_operations_producing_w3c_tracestate_check
        check (producing_traceparent is not null or producing_tracestate is null);

-- +goose Down
alter table sync_external_operations
    drop constraint sync_external_operations_producing_w3c_tracestate_check,
    drop constraint sync_external_operations_producing_tracestate_check,
    drop constraint sync_external_operations_producing_traceparent_check,
    drop column producing_traceparent,
    drop column producing_tracestate;
