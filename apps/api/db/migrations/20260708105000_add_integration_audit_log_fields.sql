-- +goose Up
alter table audit_logs
    add column resource_type text,
    add column resource_id uuid,
    add column external_request_id text;

create index audit_logs_tenant_action_created_at_id_idx
    on audit_logs(tenant_id, action, created_at desc, id desc);

create index audit_logs_tenant_resource_created_at_id_idx
    on audit_logs(tenant_id, resource_type, resource_id, created_at desc, id desc)
    where resource_type is not null and resource_id is not null;

-- +goose Down
drop index audit_logs_tenant_resource_created_at_id_idx;
drop index audit_logs_tenant_action_created_at_id_idx;

alter table audit_logs
    drop column external_request_id,
    drop column resource_id,
    drop column resource_type;
