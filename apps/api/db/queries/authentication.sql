-- name: CreatePasswordUser :one
with created_user as (
    insert into users (
        id,
        name,
        email
    ) values (
        sqlc.arg(user_id),
        sqlc.arg(name),
        sqlc.arg(email)
    )
    returning
        id,
        name,
        email,
        updated_at,
        created_at
),
created_identity as (
    insert into auth_identities (
        id,
        user_id,
        provider,
        provider_subject,
        password_hash
    ) values (
        sqlc.arg(identity_id),
        sqlc.arg(user_id),
        'password',
        sqlc.arg(email),
        sqlc.arg(password_hash)
    )
)
select
    id,
    name,
    email,
    updated_at,
    created_at
from created_user;

-- name: CreateGoogleUser :one
with created_user as (
    insert into users (
        id,
        name,
        email
    ) values (
        sqlc.arg(user_id),
        sqlc.arg(name),
        sqlc.arg(email)
    )
    returning
        id,
        name,
        email,
        updated_at,
        created_at
),
created_identity as (
    insert into auth_identities (
        id,
        user_id,
        provider,
        provider_subject
    ) values (
        sqlc.arg(identity_id),
        sqlc.arg(user_id),
        'google',
        sqlc.arg(provider_subject)
    )
)
select
    id,
    name,
    email,
    updated_at,
    created_at
from created_user;

-- name: GetPasswordIdentityByEmail :one
select
    users.id,
    users.name,
    users.email,
    users.updated_at,
    users.created_at,
    auth_identities.password_hash
from auth_identities
join users on users.id = auth_identities.user_id
where
    auth_identities.provider = 'password'
    and auth_identities.provider_subject = sqlc.arg(email)
    and auth_identities.password_hash is not null;

-- name: GetUserByAuthIdentity :one
select
    users.id,
    users.name,
    users.email,
    users.updated_at,
    users.created_at
from auth_identities
join users on users.id = auth_identities.user_id
where
    auth_identities.provider = sqlc.arg(provider)
    and auth_identities.provider_subject = sqlc.arg(provider_subject);

-- name: GetUserByEmail :one
select
    id,
    name,
    email,
    updated_at,
    created_at
from users
where email = sqlc.arg(email);

-- name: CreateLoginSession :one
insert into login_sessions (
    id,
    user_id,
    token_hash,
    user_agent,
    expires_at
) values (
    sqlc.arg(id),
    sqlc.arg(user_id),
    sqlc.arg(token_hash),
    sqlc.arg(user_agent),
    sqlc.arg(expires_at)
)
returning
    id,
    user_id,
    token_hash,
    user_agent,
    device_name,
    ip_address,
    expires_at,
    revoked_at,
    updated_at,
    created_at;

-- name: GetLoginSessionByTokenHash :one
select
    login_sessions.id as session_id,
    login_sessions.user_id,
    login_sessions.token_hash,
    login_sessions.user_agent,
    login_sessions.device_name,
    login_sessions.ip_address,
    login_sessions.expires_at,
    login_sessions.revoked_at,
    login_sessions.updated_at as session_updated_at,
    login_sessions.created_at as session_created_at,
    users.id,
    users.name,
    users.email,
    users.updated_at,
    users.created_at
from login_sessions
join users on users.id = login_sessions.user_id
where
    login_sessions.token_hash = sqlc.arg(token_hash)
    and login_sessions.expires_at > now()
    and login_sessions.revoked_at is null;

-- name: RevokeLoginSession :one
update login_sessions
set
    revoked_at = sqlc.arg(revoked_at),
    updated_at = now()
where
    id = sqlc.arg(id)
    and revoked_at is null
returning
    id,
    user_id,
    token_hash,
    user_agent,
    device_name,
    ip_address,
    expires_at,
    revoked_at,
    updated_at,
    created_at;

-- name: StorePasswordReset :exec
insert into password_resets (
    account_id,
    token_hash,
    expires_at
) values (
    sqlc.arg(account_id),
    sqlc.arg(token_hash),
    sqlc.arg(expires_at)
)
on conflict (account_id) do update set
    token_hash = excluded.token_hash,
    expires_at = excluded.expires_at,
    used_at = null,
    updated_at = now();

-- name: LockAuthenticationAccount :one
select id from users where id = sqlc.arg(account_id) for no key update;

-- name: GetAccountPasswordHash :one
select password_hash from auth_identities
where user_id = sqlc.arg(account_id) and provider = 'password';

-- name: GetPasswordResetAccount :one
select account_id from password_resets where token_hash = sqlc.arg(token_hash);

-- name: CompletePasswordReset :one
with consumed as (
    update password_resets
    set used_at = sqlc.arg(completed_at), updated_at = now()
    where password_resets.token_hash = sqlc.arg(token_hash)
      and password_resets.used_at is null
      and password_resets.expires_at > sqlc.arg(completed_at)
    returning account_id
), updated_identity as (
    update auth_identities
    set password_hash = sqlc.arg(password_hash), updated_at = now()
    from consumed
    where auth_identities.user_id = consumed.account_id
      and auth_identities.provider = 'password'
    returning auth_identities.user_id
), revoked_sessions as (
    update login_sessions
    set revoked_at = sqlc.arg(completed_at), updated_at = now()
    from updated_identity
    where login_sessions.user_id = updated_identity.user_id
      and login_sessions.revoked_at is null
)
select users.id, users.name, users.email, users.updated_at, users.created_at
from users
join updated_identity on updated_identity.user_id = users.id;
