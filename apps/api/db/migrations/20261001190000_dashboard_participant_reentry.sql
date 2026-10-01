-- +goose Up
-- Preserve old Participant generations while allowing a new admission after Leave.
drop index participants_dashboard_account_episode_idx;
create unique index participants_dashboard_account_episode_idx
    on participants(tenant_id, episode_id, account_id)
    where account_id is not null and status in ('joining', 'active');

-- +goose Down
-- Historical re-entries cannot be discarded to restore the old uniqueness rule.
-- +goose StatementBegin
do $$ begin
    raise exception 'Dashboard Participant re-entry migration cannot be reversed without discarding history';
end $$;
-- +goose StatementEnd
