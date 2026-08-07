-- +goose Up
alter table audit_logs
    drop constraint if exists audit_logs_actor_type_check;

alter table audit_logs
    add constraint audit_logs_actor_type_check
    check (actor_type in ('user', 'api_key', 'system', 'operator')) not valid;

alter table audit_logs
    validate constraint audit_logs_actor_type_check;

-- +goose Down
alter table audit_logs
    drop constraint if exists audit_logs_actor_type_check;

alter table audit_logs
    add constraint audit_logs_actor_type_check
    check (actor_type in ('user', 'api_key', 'system')) not valid;

alter table audit_logs
    validate constraint audit_logs_actor_type_check;
