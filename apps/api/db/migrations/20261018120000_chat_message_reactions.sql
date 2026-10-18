-- +goose Up
alter table sync_chat_messages add column reaction_revision bigint not null default 0 check (reaction_revision >= 0);

create table sync_chat_message_reactions (
    tenant_id uuid not null,
    space_id uuid not null,
    message_id uuid not null,
    participant_id uuid not null,
    emoji text not null,
    primary key (tenant_id, space_id, message_id, participant_id, emoji),
    foreign key (tenant_id, space_id, message_id)
        references sync_chat_messages(tenant_id, space_id, message_id) on delete cascade,
    check (emoji in ('👍', '❤️', '😂', '😮', '🎉', '👏', '😀', '😅', '🙏', '🔥', '✅', '👀', '💯', '🤔', '😢', '🙌', '🚀', '👌', '😍', '🤝', '💡', '⭐', '😎', '🥳'))
);

-- +goose Down
drop table sync_chat_message_reactions;
alter table sync_chat_messages drop column reaction_revision;
