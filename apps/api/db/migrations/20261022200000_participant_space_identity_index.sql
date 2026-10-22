-- +goose Up
-- Chat caps count every participant row of one identity in a Space, so the lookup needs this index.
create index participants_space_identity_idx
    on participants(tenant_id, space_id, identity_id)
    where identity_id is not null;

-- +goose Down
drop index participants_space_identity_idx;
