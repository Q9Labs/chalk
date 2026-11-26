-- +goose Up
create table presenting_settings (
    singleton boolean primary key default true check (singleton),
    enabled boolean not null
);

create table presenting_documents (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    document_id uuid not null,
    attachment_id uuid not null,
    created_by_participant_id uuid not null,
    created_by_participant_generation bigint not null,
    file_name text not null,
    mime_type text not null,
    byte_length bigint not null,
    source_object_key text not null,
    source_sha256 bytea not null,
    status text not null,
    failure_code text,
    failure_message text,
    page_count integer,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, document_id),
    unique (tenant_id, space_id, attachment_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict,
    foreign key (tenant_id, space_id, episode_id, created_by_participant_id, created_by_participant_generation)
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (status in ('preparing', 'ready', 'failed')),
    check (mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    check (byte_length between 1 and 26214400),
    check (octet_length(source_sha256) = 32),
    check (octet_length(source_object_key) between 1 and 1024),
    check (octet_length(file_name) between 1 and 255),
    check (failure_code is null or octet_length(failure_code) between 1 and 128),
    check (failure_message is null or octet_length(failure_message) <= 512),
    check ((status = 'failed') = (failure_code is not null)),
    check (page_count is null or page_count between 1 and 300)
);
create index presenting_documents_episode_idx
    on presenting_documents(tenant_id, space_id, episode_id, created_at, document_id);

create table presenting_document_pages (
    tenant_id uuid not null,
    space_id uuid not null,
    document_id uuid not null,
    page integer not null,
    width integer not null,
    height integer not null,
    status text not null,
    zoom_ready_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, document_id, page),
    foreign key (tenant_id, space_id, document_id)
        references presenting_documents(tenant_id, space_id, document_id)
        on delete cascade,
    check (page between 1 and 300),
    check (width between 1 and 3200 and height between 1 and 3200),
    check (status in ('pending', 'ready')),
    check ((status = 'ready') or zoom_ready_at is null)
);
create index presenting_document_pages_zoom_idx
    on presenting_document_pages(tenant_id, space_id, document_id, page)
    where zoom_ready_at is not null;

create table presenting_render_jobs (
    tenant_id uuid not null,
    space_id uuid not null,
    document_id uuid not null,
    job_id uuid not null,
    kind text not null,
    page_start integer not null,
    page_end integer not null,
    status text not null,
    attempt_count integer not null default 0,
    attempt_limit integer not null default 4,
    lease_token uuid,
    lease_owner text,
    lease_expires_at timestamptz,
    available_at timestamptz not null default now(),
    error_code text,
    error_message text,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, document_id, job_id),
    foreign key (tenant_id, space_id, document_id)
        references presenting_documents(tenant_id, space_id, document_id)
        on delete cascade,
    check (kind in ('inventory', 'pages', 'zoom')),
    check (page_start between 1 and 300 and page_end between page_start and 300),
    check (kind <> 'zoom' or page_start = page_end),
    check (status in ('queued', 'leased', 'succeeded', 'failed')),
    check (attempt_count >= 0 and attempt_count <= attempt_limit),
    check (attempt_limit between 1 and 8),
    check ((lease_token is null) = (lease_owner is null)),
    check ((lease_token is null) = (lease_expires_at is null)),
    check (lease_owner is null or octet_length(lease_owner) between 1 and 128),
    check (error_code is null or octet_length(error_code) between 1 and 128),
    check (error_message is null or octet_length(error_message) <= 512),
    check ((status in ('succeeded', 'failed')) = (completed_at is not null))
);
create unique index presenting_render_jobs_one_active_idx
    on presenting_render_jobs(tenant_id, space_id, document_id, kind, page_start, page_end)
    where status in ('queued', 'leased');
create index presenting_render_jobs_claim_idx
    on presenting_render_jobs(available_at, created_at, job_id)
    where status in ('queued', 'leased');

-- +goose Down
drop table presenting_render_jobs;
drop table presenting_document_pages;
drop table presenting_documents;
drop table presenting_settings;
