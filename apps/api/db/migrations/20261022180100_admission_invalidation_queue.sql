-- +goose Up
-- A bounded work queue, not a scan of retained terminal arrivals. Neither
-- trigger takes an authority or arrival lock after touching this queue.
create table sync_admission_invalidations (
    -- Work hints deliberately have no FK: arrival-triggered inserts must not
    -- acquire a request lock in reverse order. The sweep bounds orphan cleanup.
    admission_request_id uuid primary key,
    created_at timestamptz not null default now()
);
create index sync_admission_invalidations_order_idx
    on sync_admission_invalidations(created_at, admission_request_id);

-- +goose StatementBegin
create function enqueue_public_admission_invalidation() returns trigger language plpgsql as $$
begin
    if new.state in ('unavailable', 'rejected', 'left') then
        insert into sync_admission_invalidations(admission_request_id)
        select requests.admission_request_id
        from space_public_admission_requests public
        join sync_admission_requests requests on requests.admission_request_id = public.request_handle
          and requests.tenant_id = public.tenant_id and requests.space_id = public.space_id
        where public.tenant_id = new.tenant_id and public.arrival_handle = new.arrival_handle
          and requests.status = 'pending'
        on conflict do nothing;
    end if;
    return new;
end;
$$;
create trigger public_admission_invalidation
    after insert or update of state on space_public_arrivals
    for each row execute function enqueue_public_admission_invalidation();

create function settle_admission_invalidation() returns trigger language plpgsql as $$
begin
    if new.status = 'pending' and new.decision_external_operation_id is null
       and old.decision_external_operation_id is not null then
        -- Preserve request -> arrival -> queue lock order, including when the
        -- caller updates the public arrival later in this transaction.
        perform arrivals.arrival_handle from space_public_arrivals arrivals
        join space_public_admission_requests public
          on public.tenant_id = arrivals.tenant_id and public.arrival_handle = arrivals.arrival_handle
        where public.tenant_id = new.tenant_id and public.request_handle = new.admission_request_id
        for update of arrivals;
        insert into sync_admission_invalidations(admission_request_id)
        values (new.admission_request_id) on conflict do nothing;
    end if;
    return new;
end;
$$;
create trigger admission_invalidation_settlement
    after update of status, decision_external_operation_id on sync_admission_requests
    for each row execute function settle_admission_invalidation();
-- +goose StatementEnd

-- Include invalidations that committed before this migration installed triggers.
insert into sync_admission_invalidations(admission_request_id)
select requests.admission_request_id from sync_admission_requests requests
join space_public_admission_requests public on public.request_handle = requests.admission_request_id
    and public.tenant_id = requests.tenant_id and public.space_id = requests.space_id
join space_public_arrivals arrivals on arrivals.arrival_handle = public.arrival_handle
    and arrivals.tenant_id = public.tenant_id
where requests.status = 'pending' and requests.decision_external_operation_id is null
    and arrivals.state in ('unavailable', 'rejected', 'left')
on conflict do nothing;

-- +goose Down
drop trigger admission_invalidation_settlement on sync_admission_requests;
drop function settle_admission_invalidation();
drop trigger public_admission_invalidation on space_public_arrivals;
drop function enqueue_public_admission_invalidation();
drop table sync_admission_invalidations;
