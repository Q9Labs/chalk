-- +goose Up
set lock_timeout = '750ms';

-- +goose StatementBegin
create or replace function assign_sync_external_operation_order() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
    new.acceptance_order := next_sync_external_operation_order();
    return new;
end;
$$;
-- +goose StatementEnd

create trigger sync_external_operation_requeue_order
before update of status on sync_external_operations
for each row
when (new.status = 'pending' and new.acceptance_order is null)
execute function assign_sync_external_operation_order();

reset lock_timeout;

-- +goose Down
drop trigger if exists sync_external_operation_requeue_order on sync_external_operations;
drop function if exists assign_sync_external_operation_order();
