-- +goose Up
alter table recording_fleet_nodes
    drop constraint recording_fleet_nodes_check,
    add constraint recording_fleet_nodes_environment_provider_key
        unique (environment, provider_id),
    add constraint recording_fleet_nodes_worker_state_check
        check (
            state = 'revoked'
            or (state = 'requested') = (worker_id is null)
        );

-- +goose Down
-- A rollback would discard fail-closed authority. Refuse it after any
-- workerless abandonment tombstone has been persisted.
-- +goose StatementBegin
do $$
begin
    if exists (
        select 1
        from recording_fleet_nodes
        where state = 'revoked' and worker_id is null
    ) then
        raise exception 'cannot remove recorder fleet bootstrap abandonment support while workerless tombstones exist';
    end if;
end $$;
-- +goose StatementEnd

alter table recording_fleet_nodes
    drop constraint recording_fleet_nodes_environment_provider_key,
    drop constraint recording_fleet_nodes_worker_state_check,
    add constraint recording_fleet_nodes_check
        check ((state = 'requested') = (worker_id is null));
