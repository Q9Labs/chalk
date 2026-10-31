-- +goose Up
-- The host stop (sync_media_stops.revision) that stood when a publication grant was reserved.
-- The accepted on clears the stops up to this revision when its grant completes, and no newer one.
alter table sync_publication_grant_reservations add column answered_stop_revision bigint;

-- +goose Down
alter table sync_publication_grant_reservations drop column answered_stop_revision;
