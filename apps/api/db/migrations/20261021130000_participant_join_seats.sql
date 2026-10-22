-- +goose Up
-- Rollout: migrate, upgrade every Sync consumer, then API and client SDKs.
-- Previous API/Sync binaries remain runnable; runtime rollback keeps this schema.
-- Absence of a seat row means the legacy protocol. No historical rows change.
-- Retry rotates the participant and intent together in the authority transaction.
alter table sync_lifecycle_intents
    alter constraint sync_lifecycle_intents_sync_v3_generation_fkey deferrable initially deferred;

create table participant_join_seats (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid primary key,
    generation bigint not null check (generation > 0),
    state text not null check (state in ('pending', 'joined', 'left', 'cancelled', 'expired')),
    expires_at timestamptz not null,
    updated_at timestamptz not null default now(),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete cascade
);

-- The existing lifecycle queue delivers pending-seat expiry at next_attempt_at.
-- One authority owns the state machine for API cancellation/retry and Sync hello:
-- pending -> joined (hello), cancelled (HTTP), expired (lease).
-- cancelled/expired -> pending (retry); joined -> left (normal departure trigger).
-- +goose StatementBegin
create function transition_participant_join_seat(
    seat_tenant uuid, seat_space uuid, seat_episode uuid, seat_participant uuid,
    seat_generation bigint, action text, expected_connection text default null
) returns text language plpgsql as $$
declare
    seat participant_join_seats%rowtype;
    intent sync_lifecycle_intents%rowtype;
    terminal_state text;
begin
    if action not in ('confirm', 'cancel', 'expire', 'retry') then
        raise exception 'invalid participant join transition';
    end if;
    perform 1 from sync_episode_control
    where tenant_id = seat_tenant and space_id = seat_space and episode_id = seat_episode
    for update;
    perform 1 from participants
    where tenant_id = seat_tenant and space_id = seat_space and episode_id = seat_episode
      and id = seat_participant for update;
    select * into seat from participant_join_seats
    where tenant_id = seat_tenant and space_id = seat_space and episode_id = seat_episode
      and participant_id = seat_participant for update;
    if not found then return 'legacy'; end if;
    if seat.generation != seat_generation then return 'stale'; end if;
    if action='retry' and not exists (select 1 from episodes
        where tenant_id=seat_tenant and space_id=seat_space and id=seat_episode and status='active') then
        return 'episode_ended';
    end if;

    if action='retry' and seat.state='pending' and seat.expires_at > now()
       and exists (select 1 from participants where id=seat_participant
         and status='joining' and first_joined_at is null) then
        -- Each explicit attempt owns a new generation, even if cleanup was lost.
        update participants set generation=generation+1, media_connection_id=null,
            media_connection_generation=null, updated_at=now() where id=seat_participant;
        update participant_join_seats set generation=generation+1,
            expires_at=now()+interval '2 minutes', updated_at=now() where participant_id=seat_participant;
        update sync_lifecycle_intents set participant_generation=seat_generation+1,
            next_attempt_at=now()+interval '2 minutes'
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and participant_id=seat_participant and participant_generation=seat_generation
          and intent_name='participant_joined' and status='pending';
        return 'pending';
    end if;

    if seat.state = 'pending' then
        if action = 'cancel' then
            -- A late failure from an older attempt cannot cancel a newer grant.
            if not exists (select 1 from participants where id = seat_participant
                and media_connection_id = expected_connection) then return 'stale'; end if;
            terminal_state := 'cancelled';
        elsif seat.expires_at <= now() then
            terminal_state := 'expired';
        elsif action = 'confirm' then
            update participant_join_seats set state='joined', updated_at=now()
            where participant_id=seat_participant;
            return 'joined';
        else
            return 'pending';
        end if;

        -- Previous Sync binaries may already have applied the legacy join.
        if not exists (select 1 from participants where id = seat_participant
            and generation = seat_generation and status = 'joining') then return 'joined'; end if;
        update sync_lifecycle_intents
        set status='superseded', terminal_reason='participant_already_terminal', completed_at=now()
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and participant_id=seat_participant and participant_generation=seat_generation
          and intent_name='participant_joined' and status='pending'
        returning * into intent;
        if not found then return seat.state; end if;
        if intent.journey_id is not null then
            insert into observability_journey_events (
                event_id, journey_id, sequence, occurred_at, name, phase, state,
                origin_kind, first_observed_layer, upstream_visibility, parent_event_id,
                trace_id, span_id, attributes
            ) values (
                gen_random_uuid(), intent.journey_id, 1, now(), 'participant.join_' || terminal_state,
                'terminal', 'cancelled', 'server', case when terminal_state='expired' then 'sync' else 'api' end,
                'visible', intent.parent_journey_event_id, intent.producing_trace_id, intent.producing_span_id,
                jsonb_build_object('participant_id', seat_participant, 'reason', terminal_state)
            );
        end if;
        update participant_join_seats set state=terminal_state, updated_at=now()
        where participant_id=seat_participant;
        update participants set status='left', left_at=now(), updated_at=now() where id=seat_participant;
        update sync_episode_control set
            snapshot_reserved_bytes=snapshot_reserved_bytes-2048,
            lifecycle_reserved_events=lifecycle_reserved_events-2,
            lifecycle_reserved_bytes=lifecycle_reserved_bytes-32768,
            lifecycle_reserved_intents=lifecycle_reserved_intents-1,
            lifecycle_reserved_intent_bytes=lifecycle_reserved_intent_bytes-16384,
            updated_at=now()
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode;
        seat.state := terminal_state;
    end if;

    if action='retry' and seat.state in ('cancelled','expired') then
        update sync_episode_control set
            snapshot_reserved_bytes=snapshot_reserved_bytes+2048,
            lifecycle_reserved_events=lifecycle_reserved_events+2,
            lifecycle_reserved_bytes=lifecycle_reserved_bytes+32768,
            lifecycle_reserved_intents=lifecycle_reserved_intents+1,
            lifecycle_reserved_intent_bytes=lifecycle_reserved_intent_bytes+16384,
            updated_at=now()
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and snapshot_bytes+snapshot_reserved_bytes+2048 <= 1048576
          and lifecycle_event_count+lifecycle_reserved_events+2 <= 2048
          and lifecycle_event_bytes+lifecycle_reserved_bytes+32768 <= 33554432
          and lifecycle_intent_count+lifecycle_reserved_intents+1 <= 2048
          and lifecycle_intent_bytes+lifecycle_reserved_intent_bytes+16384 <= 33554432
          and (select count(*) from participants where tenant_id=seat_tenant and space_id=seat_space
            and episode_id=seat_episode and status in ('joining','active','leaving')) < 500;
        if not found then return 'capacity_exceeded'; end if;
        update participants set status='joining', generation=generation+1, left_at=null, media_connection_id=null,
            media_connection_generation=null, updated_at=now() where id=seat_participant;
        update participant_join_seats set state='pending', generation=generation+1, expires_at=now()+interval '2 minutes', updated_at=now()
        where participant_id=seat_participant;
        update sync_lifecycle_intents set status='pending', participant_generation=seat_generation+1, terminal_reason=null, completed_at=null,
            attempt_count=0, last_error_code=null, next_attempt_at=now()+interval '2 minutes'
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and participant_id=seat_participant and participant_generation=seat_generation
          and intent_name='participant_joined' and status='superseded'
          and terminal_reason='participant_already_terminal';
        return 'pending';
    end if;
    return seat.state;
end;
$$;
-- +goose StatementEnd

-- Normal leave and Episode end also close the seat, including older binaries.
-- +goose StatementBegin
create function complete_participant_join_seat() returns trigger language plpgsql as $$
begin
    if new.status='left' then
        update participant_join_seats
        set state=case when state='joined' or new.first_joined_at is not null then 'left' else 'cancelled' end, updated_at=now()
        where participant_id=new.id and generation=new.generation and state in ('pending','joined');
    end if;
    return new;
end;
$$;
create trigger participant_join_seat_departure after update of status on participants
    for each row execute function complete_participant_join_seat();
-- +goose StatementEnd

-- +goose Down
-- Runtime rollback leaves this additive migration in place.
drop trigger participant_join_seat_departure on participants;
drop function complete_participant_join_seat();
drop function transition_participant_join_seat(uuid, uuid, uuid, uuid, bigint, text, text);
drop table participant_join_seats;

alter table sync_lifecycle_intents
    alter constraint sync_lifecycle_intents_sync_v3_generation_fkey not deferrable;
