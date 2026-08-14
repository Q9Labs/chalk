-- +goose Up
-- Active Episode creation historically allowed a missing start timestamp. The
-- API now supplies the database transaction time, and this repair makes those
-- authoritative rows visible to Episode Diagnostics reconciliation.
update episodes
set started_at = created_at
where started_at is null;

-- The asynchronous observer projected Go's zero time for historical rows. Keep
-- the diagnostic root aligned with the repaired authoritative Episode.
update episode_diagnostics as diagnostic
set episode_started_at = episode.started_at,
    updated_at = now()
from episodes as episode
where diagnostic.tenant_id = episode.tenant_id
  and diagnostic.space_id = episode.space_id
  and diagnostic.episode_id = episode.id
  and diagnostic.episode_started_at is distinct from episode.started_at;

-- +goose Down
-- The previous null and year-one timestamps cannot be reconstructed after the
-- repair. Refuse a false rollback instead of corrupting migration history.
-- +goose StatementBegin
do $$
begin
    raise exception 'Episode start timestamp repair is irreversible';
end;
$$;
-- +goose StatementEnd
