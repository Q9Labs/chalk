-- name: ExpireHelperDeviceRequests :exec
delete from helper_device_requests
where id in (select id from helper_device_requests where expires_at <= now() order by expires_at limit 25);

-- name: FindHelperDeviceByCredential :one
select * from helper_devices where credential_hash = $1 and revoked_at is null;

-- name: StartHelperDeviceRequest :exec
insert into helper_device_requests (id, code_hash, poll_hash, name, public_key, credential_hash, device_id, expires_at)
values ($1, $2, $3, $4, $5, $6, $7, now() + interval '5 minutes');

-- name: LookupHelperDeviceRequest :one
select request.id, request.name, request.public_key
from helper_device_requests request
left join helper_devices device on device.id = request.device_id
where request.code_hash = $1 and request.expires_at > now() and request.approved_share is null
and (request.device_id is null or (device.tenant_id = $2 and device.revoked_at is null));

-- name: LockHelperDeviceRequest :one
select * from helper_device_requests where id = $1 and expires_at > now() for update;

-- name: RegisterHelperDevice :exec
insert into helper_devices (id, tenant_id, name, public_key, credential_hash)
values ($1, $2, $3, $4, $5);

-- name: LockActiveHelperDevice :one
select * from helper_devices where id = $1 and revoked_at is null for update;

-- name: ApproveHelperDeviceRequest :exec
update helper_device_requests set device_id = $2, approved_share = $3,
    approval_expires_at = now() + interval '25 seconds', expires_at = now() + interval '5 minutes'
where id = $1;

-- name: PollHelperDeviceRequest :one
update helper_device_requests set next_poll_at = now() + interval '3 seconds'
where poll_hash = $1 and expires_at > now() and next_poll_at <= now()
returning *;

-- name: ReadHelperDevices :many
select id, name from helper_devices where tenant_id = $1 and revoked_at is null order by registered_at desc limit 100;

-- name: RevokeHelperDevice :exec
update helper_devices set revoked_at = now() where id = $1 and tenant_id = $2 and revoked_at is null;
