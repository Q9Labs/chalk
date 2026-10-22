-- +goose Up
-- Chat limits apply to a person, not a seat. A rejoin creates a new participant row, so the
-- person is the account, else the identity, else that one row (a guest has no stable key).
create index participants_chat_person_idx
    on participants(tenant_id, space_id, (coalesce(account_id, identity_id, id)));

-- Sync counts a person's messages under the Space stream lock on every send, so it reads
-- only this index and never the Space's whole message history.
create index sync_chat_messages_participant_usage_idx
    on sync_chat_messages(tenant_id, space_id, participant_id) include (created_at, encoded_bytes);

-- +goose StatementBegin
create function chat_person_participant_ids(p_tenant_id uuid, p_space_id uuid, p_participant_id uuid)
returns table (participant_id uuid)
language sql
stable
as $$
    select sibling.id
    from participants sender
    join participants sibling
        on sibling.tenant_id = sender.tenant_id
        and sibling.space_id = sender.space_id
        and coalesce(sibling.account_id, sibling.identity_id, sibling.id)
            = coalesce(sender.account_id, sender.identity_id, sender.id)
    where sender.tenant_id = p_tenant_id
        and sender.space_id = p_space_id
        and sender.id = p_participant_id
$$;
-- +goose StatementEnd

-- +goose Down
drop function chat_person_participant_ids(uuid, uuid, uuid);
drop index sync_chat_messages_participant_usage_idx;
drop index participants_chat_person_idx;
