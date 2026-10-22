-- +goose Up
-- +goose StatementBegin
create function sync_admission_expiry_due(request_expires_at timestamptz, arrival_state text, as_of timestamptz)
returns boolean
language sql immutable parallel safe
as $$
    select request_expires_at <= as_of
        or coalesce(arrival_state in ('unavailable', 'rejected', 'left'), false);
$$;
-- +goose StatementEnd

-- +goose Down
drop function sync_admission_expiry_due(timestamptz, text, timestamptz);
