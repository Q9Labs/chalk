-- +goose Up
-- Old API replicas must not commit legacy decisions for Sync-owned knocks.
-- +goose StatementBegin
create function guard_canonical_public_admission_decision()
returns trigger
language plpgsql
as $$
declare
    canonical_state text;
begin
    select case when status = 'admitted' then 'approved' else status end
      into canonical_state
      from sync_admission_requests
      where tenant_id = new.tenant_id and space_id = new.space_id
        and admission_request_id = new.request_handle;
    if found and new.state <> canonical_state then
        raise exception 'canonical admission decisions are owned by Sync'
            using errcode = '23514';
    end if;
    return new;
end;
$$;

create trigger space_public_admission_requests_canonical_decision
before update of state on space_public_admission_requests
for each row when (old.state is distinct from new.state)
execute function guard_canonical_public_admission_decision();
-- +goose StatementEnd

-- +goose Down
drop trigger space_public_admission_requests_canonical_decision on space_public_admission_requests;
drop function guard_canonical_public_admission_decision();
