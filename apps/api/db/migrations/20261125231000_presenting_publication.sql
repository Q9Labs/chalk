-- +goose Up
alter table presenting_document_pages
    add column image_key text,
    add column thumbnail_key text,
    add column zoom_key text;

alter table presenting_document_pages
    add constraint presenting_document_pages_image_key_length
        check (image_key is null or octet_length(image_key) between 1 and 1024),
    add constraint presenting_document_pages_thumbnail_key_length
        check (thumbnail_key is null or octet_length(thumbnail_key) between 1 and 1024),
    add constraint presenting_document_pages_zoom_key_length
        check (zoom_key is null or octet_length(zoom_key) between 1 and 1024),
    add constraint presenting_document_pages_ready_has_objects
        check (status <> 'ready' or (image_key is not null and thumbnail_key is not null)),
    add constraint presenting_document_pages_zoom_object_receipt
        check ((zoom_ready_at is null) = (zoom_key is null));

create table presenting_render_uploads (
    tenant_id uuid not null,
    space_id uuid not null,
    document_id uuid not null,
    job_id uuid not null,
    page integer not null,
    rendition text not null,
    attempt integer not null,
    object_key text not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, space_id, document_id, job_id, page, rendition, attempt),
    foreign key (tenant_id, space_id, document_id, job_id)
        references presenting_render_jobs(tenant_id, space_id, document_id, job_id)
        on delete cascade,
    unique (object_key),
    check (page between 1 and 300),
    check (rendition in ('image', 'thumbnail', 'zoom')),
    check (attempt between 1 and 8),
    check (octet_length(object_key) between 1 and 1024)
);
create index presenting_render_uploads_document_idx
    on presenting_render_uploads(tenant_id, space_id, document_id, created_at);

-- +goose Down
drop table presenting_render_uploads;
alter table presenting_document_pages
    drop constraint presenting_document_pages_zoom_object_receipt,
    drop constraint presenting_document_pages_ready_has_objects,
    drop constraint presenting_document_pages_zoom_key_length,
    drop constraint presenting_document_pages_thumbnail_key_length,
    drop constraint presenting_document_pages_image_key_length,
    drop column zoom_key,
    drop column thumbnail_key,
    drop column image_key;
