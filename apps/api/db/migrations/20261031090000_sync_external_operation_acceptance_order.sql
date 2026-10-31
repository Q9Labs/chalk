-- +goose Up
create sequence sync_external_operation_acceptance_order_seq as bigint;

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

select setval('sync_external_operation_acceptance_order_seq',
    coalesce((select max(acceptance_order) from sync_external_operations), 0) + 1, false);

alter table sync_external_operations
    alter column acceptance_order set default nextval('sync_external_operation_acceptance_order_seq'),
    alter column acceptance_order set not null;
alter sequence sync_external_operation_acceptance_order_seq
    owned by sync_external_operations.acceptance_order;
create unique index sync_external_operations_acceptance_order_key
    on sync_external_operations(acceptance_order);

-- +goose Down
alter table sync_external_operations drop column acceptance_order;
