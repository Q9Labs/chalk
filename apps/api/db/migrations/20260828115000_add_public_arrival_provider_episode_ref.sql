-- +goose Up
alter table space_public_arrivals
    add column provider_episode_ref text;

alter table space_public_arrivals
    add constraint space_public_arrivals_provider_episode_ref_check
    check (provider_episode_ref is null or octet_length(provider_episode_ref) between 1 and 256);

-- +goose Down
alter table space_public_arrivals
    drop constraint space_public_arrivals_provider_episode_ref_check,
    drop column provider_episode_ref;
