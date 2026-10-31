-- +goose Up
alter table sync_external_operations add column acceptance_order bigint;

-- Historical acceptance cannot be reconstructed from transaction timestamps.
-- Keep the previous stable order for existing rows; new inserts allocate their
-- order while holding the Episode authority lock.
with ordered as (
    select external_operation_id,
        row_number() over (order by created_at, external_operation_id) as position
    from sync_external_operations
)
update sync_external_operations operation
set acceptance_order = ordered.position
from ordered
where operation.external_operation_id = ordered.external_operation_id;

alter table sync_external_operations
    alter column acceptance_order set not null,
    alter column acceptance_order add generated always as identity;

select setval(pg_get_serial_sequence('sync_external_operations', 'acceptance_order'),
    coalesce((select max(acceptance_order) from sync_external_operations), 0) + 1, false);

create unique index sync_external_operations_acceptance_order_key
    on sync_external_operations(acceptance_order);

-- +goose Down
alter table sync_external_operations drop column acceptance_order;
