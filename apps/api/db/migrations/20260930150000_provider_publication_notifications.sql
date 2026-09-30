-- +goose Up
-- +goose StatementBegin
create function notify_provider_publication_observation() returns trigger
language plpgsql as $$
declare
    episode_space_id uuid;
begin
    select space_id into episode_space_id
    from episodes
    where tenant_id = new.tenant_id and id = new.episode_id;

    if episode_space_id is not null then
        perform pg_notify(
            'chalk_media_publications',
            new.tenant_id::text || ':' || episode_space_id::text || ':' || new.episode_id::text
        );
    end if;
    return new;
end;
$$;
-- +goose StatementEnd

create trigger provider_publication_observation_notify
after insert on provider_operation_observations
for each row execute function notify_provider_publication_observation();

-- +goose Down
drop trigger provider_publication_observation_notify on provider_operation_observations;
drop function notify_provider_publication_observation();
