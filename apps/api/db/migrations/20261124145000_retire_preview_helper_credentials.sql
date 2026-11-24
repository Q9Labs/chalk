-- +goose Up
-- Preview device credentials used exportable Ed25519 keys. Revoke them even
-- on clients that never upgrade. Do not affect newly enrolled P-256 devices.
update helper_devices set revoked_at = now()
where revoked_at is null and (loopback or length(public_key) = 43);

delete from helper_device_requests where length(public_key) = 43;

-- +goose Down
-- Intentionally do not restore revoked credentials or pending codes.
select 1;
