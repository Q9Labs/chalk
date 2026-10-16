-- +goose Up
-- RealtimeKit support is removed in the accompanying API release. Convert old
-- Spaces before that API becomes ready; credentials remain untouched.
update spaces set media_plane = 'cf_sfu' where media_plane = 'cf_rtk';
update tenants set default_media_plane = 'cf_sfu' where default_media_plane = 'cf_rtk';

-- +goose Down
-- Prior provider selections cannot be reconstructed after conversion.
-- +goose StatementBegin
do $$
begin
    raise exception 'RealtimeKit provider conversion is irreversible; restore from backup';
end;
$$;
-- +goose StatementEnd
