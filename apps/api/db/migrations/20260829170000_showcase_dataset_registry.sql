-- +goose Up
create table showcase_dataset_registries (
    dataset_id text not null,
    product text not null,
    dataset_version text not null,
    organization_key text not null,
    organization_id uuid not null,
    owner_user_id uuid not null references users(id),
    state text not null check (state in ('applying', 'applied')),
    manifest_sha256 bytea not null check (octet_length(manifest_sha256) = 32),
    assets_sha256 bytea not null check (octet_length(assets_sha256) = 32),
    counts jsonb not null check (jsonb_typeof(counts) = 'object'),
    pending_asset_keys jsonb not null check (jsonb_typeof(pending_asset_keys) = 'array'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (dataset_id, product, organization_key),
    unique (dataset_id, product, organization_id),
    check (length(dataset_id) between 1 and 128),
    check (length(product) between 1 and 128),
    check (length(dataset_version) between 1 and 64),
    check (length(organization_key) between 1 and 256)
);
create index showcase_dataset_registries_owner_idx
    on showcase_dataset_registries(owner_user_id, created_at desc);

-- +goose Down
drop table showcase_dataset_registries;
