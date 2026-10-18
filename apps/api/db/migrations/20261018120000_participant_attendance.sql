-- +goose Up
alter table participants
    add column first_joined_at timestamptz,
    add column last_left_reason text check (last_left_reason in ('left', 'episode_ended'));

-- +goose Down
-- Dropping the columns would delete recorded attendance. Refuse the rollback
-- once any seat has a first join or a leave reason; the old code ignores both
-- columns, so a revert of the code does not need this rollback.
-- +goose StatementBegin
do $$
begin
    if exists (
        select 1
        from participants
        where first_joined_at is not null or last_left_reason is not null
    ) then
        raise exception 'cannot drop participant attendance columns while attendance is recorded';
    end if;
end;
$$;
-- +goose StatementEnd

alter table participants drop column last_left_reason, drop column first_joined_at;
