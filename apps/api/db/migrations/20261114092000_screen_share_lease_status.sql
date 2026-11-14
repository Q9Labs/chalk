-- +goose Up
-- No code ever writes the 'acquiring' status, and loading such a row would crash Live.Episode.
delete from sync_screen_share_leases where status = 'acquiring';
-- +goose StatementBegin
DO $$
DECLARE
    old_check text;
BEGIN
    SELECT conname INTO old_check FROM pg_constraint
    WHERE conrelid = 'sync_screen_share_leases'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%acquiring%';
    IF old_check IS NOT NULL THEN
        EXECUTE format('ALTER TABLE sync_screen_share_leases DROP CONSTRAINT %I', old_check);
    END IF;
END $$;
-- +goose StatementEnd
alter table sync_screen_share_leases
    add constraint sync_screen_share_leases_status_check check (status = 'active');

-- +goose Down
alter table sync_screen_share_leases
    drop constraint sync_screen_share_leases_status_check,
    add constraint sync_screen_share_leases_status_check check (status in ('acquiring', 'active'));
