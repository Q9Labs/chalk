-- +goose Up

-- Collapse the retired four-level tenant role vocabulary into the three
-- glossary roles. Space roles are customer-defined and are unaffected.
update memberships
set role = case role
    when 'admin' then 'collaborator'
    when 'member' then 'collaborator'
    when 'viewer' then 'observer'
    else role
end
where role in ('admin', 'member', 'viewer');

-- +goose Down

-- The old vocabulary had two distinct middle roles, so this rollback keeps
-- the replacement role rather than guessing which retired role was intended.
-- Fail explicitly: Goose must not record a rollback that silently preserves
-- collapsed data as though the old vocabulary had been restored.
-- +goose StatementBegin
do $$
begin
    raise exception 'membership role vocabulary migration is irreversible after admin/member collapse';
end
$$;
-- +goose StatementEnd
