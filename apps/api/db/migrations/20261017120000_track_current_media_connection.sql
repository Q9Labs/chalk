-- +goose Up
SET LOCAL lock_timeout = '5s';
alter table participants add column media_connection_id text;
alter table participants add column media_connection_generation bigint;

-- +goose StatementBegin
create function bind_public_arrival_media_connection() returns trigger
language plpgsql as $$
begin
    if new.state = 'admitted' and new.provider_subject is not null and
       (TG_OP = 'INSERT' or old.state is distinct from new.state or
        old.provider_subject is distinct from new.provider_subject or
        old.participant_generation is distinct from new.participant_generation or
        old.participant_id is distinct from new.participant_id) then
        update participants set media_connection_id = new.provider_subject,
            media_connection_generation = new.participant_generation
        where tenant_id = new.tenant_id and episode_id = new.episode_id
          and id = new.participant_id and generation = new.participant_generation;
    end if;
    return new;
end;
$$;
-- +goose StatementEnd
create trigger public_arrival_media_connection
    after insert or update of state, provider_subject, participant_generation, participant_id
    on space_public_arrivals for each row execute function bind_public_arrival_media_connection();

update participants set media_connection_id = arrival.provider_subject,
    media_connection_generation = arrival.participant_generation
from (
    select distinct on (tenant_id, episode_id, participant_id, participant_generation)
        tenant_id, episode_id, participant_id, participant_generation, provider_subject
    from space_public_arrivals where state = 'admitted'
    order by tenant_id, episode_id, participant_id, participant_generation, updated_at desc
) arrival
where participants.tenant_id = arrival.tenant_id and participants.episode_id = arrival.episode_id
  and participants.id = arrival.participant_id and participants.generation = arrival.participant_generation;

-- +goose Down
SET LOCAL lock_timeout = '5s';
drop trigger public_arrival_media_connection on space_public_arrivals;
drop function bind_public_arrival_media_connection();
alter table participants drop column media_connection_generation;
alter table participants drop column media_connection_id;
