-- +goose NO TRANSACTION
-- +goose Up
-- Follow-up to the PlanetScale recommendation pass. users_created_at_id_idx has no list query (users
-- are only read by id). sync_chat_attachments_cleanup_idx cannot serve ClaimChatAttachmentCleanup,
-- which ORs its expiry arm with an arm on the joined Episode. The new partial index lets the
-- readiness retention-lag read, run about once a second, find uncleaned Episodes without scanning
-- every Episode control row. Every statement is concurrent and commits on its own, so a run that
-- stops early runs again safely: the new index is dropped before it is created, so a build that failed and left an invalid index is rebuilt.
-- chalk:removed-in #1423
drop index concurrently if exists users_created_at_id_idx;
drop index concurrently if exists sync_chat_attachments_cleanup_idx;
drop index concurrently if exists sync_episode_control_retention_pending_idx;
create index concurrently sync_episode_control_retention_pending_idx
    on sync_episode_control (tenant_id, space_id, episode_id) where retention_cleaned_at is null;

-- +goose Down
drop index concurrently if exists sync_episode_control_retention_pending_idx;
create index concurrently if not exists users_created_at_id_idx on users (created_at desc, id desc);
create index concurrently if not exists sync_chat_attachments_cleanup_idx
    on sync_chat_attachments (status, expires_at) where status <> 'attached';
