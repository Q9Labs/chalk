-- +goose NO TRANSACTION
-- +goose Up
set lock_timeout = '750ms';

begin;
create sequence if not exists sync_external_operation_acceptance_order_seq as bigint;

-- Bind the sequence at creation, with a fixed search path at execution. Runtime
-- writers need only their existing table grants, including during a rolling deploy.
create or replace function next_sync_external_operation_order() returns bigint
    language sql volatile security definer set search_path = pg_catalog
    return nextval('sync_external_operation_acceptance_order_seq'::regclass);

alter table sync_external_operations add column if not exists acceptance_order bigint;
alter table sync_external_operations
    alter column acceptance_order set default next_sync_external_operation_order();
alter sequence sync_external_operation_acceptance_order_seq
    owned by sync_external_operations.acceptance_order;
commit;

-- Terminal history is never claimed. Commit each pending-only batch separately;
-- legacy negative orders precede positive orders allocated by concurrent inserts.
-- On restart, completed batches keep their values and the sequence keeps advancing.
-- +goose StatementBegin
do $$
declare
    affected integer;
begin
    loop
        perform set_config('chalk.entry_writer', '1', true);
        with batch as materialized (
            select external_operation_id, created_at
            from sync_external_operations
            where status = 'pending' and acceptance_order is null
            order by created_at, external_operation_id
            limit 1000
            for update
        ), ordered as materialized (
            select external_operation_id,
                next_sync_external_operation_order() - 9223372036854775807 as position
            from batch
            order by created_at, external_operation_id
        )
        update sync_external_operations operation
        set acceptance_order = ordered.position
        from ordered
        where operation.external_operation_id = ordered.external_operation_id;
        get diagnostics affected = row_count;
        commit;
        exit when affected = 0;
    end loop;
end;
$$;
-- +goose StatementEnd

-- New writers already allocate non-null orders. Check existing pending rows
-- online; validating the check permits ordinary reads, claims and inserts.
-- +goose StatementBegin
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'sync_external_operations'::regclass
            and conname = 'sync_external_operations_pending_order_check'
    ) then
        alter table sync_external_operations
            add constraint sync_external_operations_pending_order_check
            check (status <> 'pending' or acceptance_order is not null) not valid;
    end if;
end;
$$;
-- +goose StatementEnd
alter table sync_external_operations
    validate constraint sync_external_operations_pending_order_check;
reset lock_timeout;

-- +goose Down
-- Runtime rollback leaves this additive schema in place. Down discards orders
-- and is only safe after all consumers of acceptance_order have stopped.
set lock_timeout = '750ms';
begin;
alter table sync_external_operations alter column acceptance_order drop default;
drop function if exists next_sync_external_operation_order();
alter table sync_external_operations drop column acceptance_order;
commit;
reset lock_timeout;
