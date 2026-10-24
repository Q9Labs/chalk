-- +goose Up
create table sync_entry_rollout (
    singleton boolean primary key default true check (singleton),
    enforced boolean not null default false,
    enforced_at timestamptz,
    release_id text,
    check (enforced = (enforced_at is not null and release_id is not null))
);
insert into sync_entry_rollout(singleton) values (true);

-- Every writer takes this row lock before entry/Leave mutations. Enforcement
-- waits for earlier transactions; subsequent old transactions fail closed.
-- +goose StatementBegin
create function require_sync_entry_writer() returns trigger language plpgsql as $$
declare enabled boolean;
begin
    select enforced into strict enabled from sync_entry_rollout where singleton for share;
    if enabled and current_setting('chalk.entry_writer', true) is distinct from '1' then
        -- A still-current compatibility socket may request Leave. Only the new
        -- consumer can claim/finalize it; old provider dispatch remains fenced.
        if tg_table_name='sync_external_operations' and tg_op='INSERT' then
            if not exists (select 1 from participant_join_seats
                           where participant_id=new.target_participant_id
                             and generation=new.target_participant_generation
                             and confirmed_entry_generation > 0) then
                return new;
            end if;
        end if;
        raise exception 'Sync entry writer upgrade required' using errcode='55000';
    end if;
    return new;
end;
$$;
-- +goose StatementEnd
create trigger sync_entry_participant_writer before update of status on participants
    for each row when (new.status is distinct from old.status and
      (new.status='active' or (new.status='left' and old.first_joined_at is not null)))
    execute function require_sync_entry_writer();
create trigger sync_entry_leave_writer before insert or update on sync_external_operations
    for each row when (new.operation_name='participant_leave') execute function require_sync_entry_writer();
create trigger sync_entry_event_writer before insert on sync_control_events
    for each row execute function require_sync_entry_writer();

-- +goose StatementBegin
create function enforce_sync_entry_ownership(target_release text) returns void language plpgsql as $$
begin
    perform 1 from sync_entry_rollout where singleton for update;
    if (select enforced from sync_entry_rollout where singleton) then return; end if;
    if target_release is null or length(target_release)=0 then
        raise exception 'entry enforcement requires a release identity';
    end if;
    -- A provider call outlives its claiming transaction. Drain it while all
    -- sockets still use compatibility semantics, before issuing owned entries.
    if exists (select 1 from sync_external_operations where operation_name='participant_leave'
               and status='pending' and attempt_count > 0) then
        raise exception 'entry enforcement requires claimed Leaves to finish' using errcode='55000';
    end if;
    update sync_entry_rollout set enforced=true,enforced_at=clock_timestamp(),release_id=target_release
      where singleton;
end;
$$;
-- +goose StatementEnd

-- +goose Down
-- Runtime rollback never runs Down or clears the recorded enforcement switch.
drop trigger sync_entry_event_writer on sync_control_events;
drop trigger sync_entry_leave_writer on sync_external_operations;
drop trigger sync_entry_participant_writer on participants;
drop function enforce_sync_entry_ownership(text);
drop function require_sync_entry_writer();
drop table sync_entry_rollout;
