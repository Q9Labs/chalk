-- +goose Up
-- +goose StatementBegin
create function space_public_invite_code(handle bytea) returns text
language sql immutable strict parallel safe
as $$
    select string_agg(chr(97 + get_byte(digest, i) % 26), '' order by i)
    from (select sha256('chalk/public-invite/code/v1'::bytea || handle) as digest) hashed,
         generate_series(0, 9) as i
$$;
-- +goose StatementEnd

alter table space_public_invites
    add column invite_code text not null generated always as (space_public_invite_code(handle)) stored;

create unique index space_public_invites_invite_code_idx on space_public_invites(invite_code);

-- +goose Down
drop index space_public_invites_invite_code_idx;
alter table space_public_invites drop column invite_code;
drop function space_public_invite_code(bytea);
