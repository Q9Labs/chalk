-- name: PresentingEnabled :one
select coalesce((select enabled from presenting_settings where singleton), sqlc.arg(default_enabled)::boolean)::boolean;

-- name: CreatePresentingDocument :one
with authority as materialized (
    select
        participant.tenant_id,
        participant.space_id,
        participant.episode_id,
        participant.id as participant_id,
        participant.generation as participant_generation,
        attachment.attachment_id,
        attachment.original_filename,
        attachment.mime_type,
        attachment.byte_length,
        attachment.object_key,
        attachment.sha256
    from participants participant
    join episodes episode
        on episode.tenant_id = participant.tenant_id
        and episode.space_id = participant.space_id
        and episode.id = participant.episode_id
    join sync_chat_attachments attachment
        on attachment.tenant_id = participant.tenant_id
        and attachment.space_id = participant.space_id
        and attachment.episode_id = participant.episode_id
    where participant.tenant_id = sqlc.arg(tenant_id)
        and participant.space_id = sqlc.arg(space_id)
        and participant.episode_id = sqlc.arg(episode_id)
        and participant.id = sqlc.arg(participant_id)
        and participant.generation = sqlc.arg(participant_generation)
        and participant.status = 'active'
        and episode.status = 'active'
        and participant.capabilities @> array['publishScreen']::text[]
        and attachment.attachment_id = sqlc.arg(attachment_id)
        and attachment.cleanup_claim_token is null
        and (
            attachment.status = 'attached'
            or (
                attachment.status = 'ready'
                and attachment.participant_id = participant.id
                and attachment.participant_generation = participant.generation
                and attachment.expires_at > now()
            )
        )
),
inserted as (
    insert into presenting_documents (
        tenant_id, space_id, episode_id, document_id, attachment_id,
        created_by_participant_id, created_by_participant_generation,
        file_name, mime_type, byte_length, source_object_key, source_sha256, status
    )
    select
        authority.tenant_id, authority.space_id, authority.episode_id, sqlc.arg(document_id), authority.attachment_id,
        authority.participant_id, authority.participant_generation,
        authority.original_filename, authority.mime_type, authority.byte_length, authority.object_key, authority.sha256, 'preparing'
    from authority
    on conflict (tenant_id, space_id, attachment_id) do nothing
    returning
        tenant_id, space_id, episode_id, document_id, attachment_id,
        file_name, mime_type, byte_length, source_object_key, source_sha256,
        status, failure_code, failure_message, page_count, created_at, updated_at, true as created
),
selected as (
    select * from inserted
    union all
    select
        document.tenant_id, document.space_id, document.episode_id, document.document_id, document.attachment_id,
        document.file_name, document.mime_type, document.byte_length, document.source_object_key, document.source_sha256,
        document.status, document.failure_code, document.failure_message, document.page_count, document.created_at, document.updated_at, false as created
    from presenting_documents document
    join authority on true
    where document.tenant_id = authority.tenant_id
        and document.space_id = authority.space_id
        and document.attachment_id = authority.attachment_id
        and not exists (select 1 from inserted)
)
select * from selected;

-- name: GetAuthorizedPresentingDocument :one
select
    document.tenant_id, document.space_id, document.episode_id, document.document_id, document.attachment_id,
    document.file_name, document.mime_type, document.byte_length, document.source_object_key, document.source_sha256,
    document.status, document.failure_code, document.failure_message, document.page_count, document.created_at, document.updated_at
from presenting_documents document
join participants participant
    on participant.tenant_id = document.tenant_id
    and participant.space_id = document.space_id
    and participant.episode_id = document.episode_id
join episodes episode
    on episode.tenant_id = document.tenant_id
    and episode.space_id = document.space_id
    and episode.id = document.episode_id
where document.tenant_id = sqlc.arg(tenant_id)
    and document.space_id = sqlc.arg(space_id)
    and document.episode_id = sqlc.arg(episode_id)
    and document.document_id = sqlc.arg(document_id)
    and participant.id = sqlc.arg(participant_id)
    and participant.generation = sqlc.arg(participant_generation)
    and participant.status = 'active'
    and episode.status = 'active';

-- name: ListPresentingDocumentPages :many
select tenant_id, space_id, document_id, page, width, height, status, zoom_ready_at, created_at, updated_at
from presenting_document_pages
where tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and document_id = sqlc.arg(document_id)
order by page;

-- name: GetAuthorizedPresentingPage :one
select
    document.status as document_status,
    page.tenant_id, page.space_id, page.document_id, page.page, page.width, page.height, page.status, page.zoom_ready_at, page.created_at, page.updated_at
from presenting_document_pages page
join presenting_documents document
    on document.tenant_id = page.tenant_id
    and document.space_id = page.space_id
    and document.document_id = page.document_id
join participants participant
    on participant.tenant_id = document.tenant_id
    and participant.space_id = document.space_id
    and participant.episode_id = document.episode_id
join episodes episode
    on episode.tenant_id = document.tenant_id
    and episode.space_id = document.space_id
    and episode.id = document.episode_id
where page.tenant_id = sqlc.arg(tenant_id)
    and page.space_id = sqlc.arg(space_id)
    and document.episode_id = sqlc.arg(episode_id)
    and page.document_id = sqlc.arg(document_id)
    and page.page = sqlc.arg(page)
    and participant.id = sqlc.arg(participant_id)
    and participant.generation = sqlc.arg(participant_generation)
    and participant.status = 'active'
    and episode.status = 'active';

-- name: CreatePresentingRenderJob :one
insert into presenting_render_jobs (
    tenant_id, space_id, document_id, job_id, kind, page_start, page_end, status, attempt_limit, available_at
) values (
    sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(document_id), sqlc.arg(job_id), sqlc.arg(kind), sqlc.arg(page_start), sqlc.arg(page_end), 'queued', sqlc.arg(attempt_limit), sqlc.arg(available_at)
)
on conflict do nothing
returning tenant_id, space_id, document_id, job_id, kind, page_start, page_end, status, attempt_count, attempt_limit, lease_token, lease_owner, lease_expires_at, available_at, error_code, error_message, completed_at, created_at, updated_at;

-- name: ClaimPresentingRenderJob :one
with expired as (
    update presenting_render_jobs job
    set status = 'failed', error_code = 'timeout', error_message = 'Render worker lease expired at the attempt limit', completed_at = now(), updated_at = now()
    where job.status = 'leased'
        and job.lease_expires_at <= sqlc.arg(now_at)
        and job.attempt_count >= job.attempt_limit
    returning job.tenant_id, job.space_id, job.document_id, job.kind
),
failed_documents as (
    update presenting_documents document
    set status = 'failed', failure_code = 'timeout', failure_message = 'Rendering timed out', updated_at = now()
    from expired
    where document.tenant_id = expired.tenant_id
        and document.space_id = expired.space_id
        and document.document_id = expired.document_id
        and expired.kind in ('inventory', 'pages')
        and document.status <> 'failed'
    returning document.document_id
),
candidate as (
    select job.tenant_id, job.space_id, job.document_id, job.job_id
    from presenting_render_jobs job
    join presenting_documents document
        on document.tenant_id = job.tenant_id
        and document.space_id = job.space_id
        and document.document_id = job.document_id
    where job.status in ('queued', 'leased')
        and job.available_at <= sqlc.arg(now_at)
        and (job.status = 'queued' or job.lease_expires_at <= sqlc.arg(now_at))
        and job.attempt_count < job.attempt_limit
        and (sqlc.narg(job_id)::uuid is null or job.job_id = sqlc.narg(job_id)::uuid)
        and document.status <> 'failed'
    order by job.available_at, job.created_at, job.job_id
    for update of job skip locked
    limit 1
)
update presenting_render_jobs job
set status = 'leased', attempt_count = attempt_count + 1,
    lease_token = sqlc.arg(lease_token), lease_owner = sqlc.arg(lease_owner), lease_expires_at = sqlc.arg(lease_expires_at), updated_at = now()
from candidate
where job.tenant_id = candidate.tenant_id
    and job.space_id = candidate.space_id
    and job.document_id = candidate.document_id
    and job.job_id = candidate.job_id
returning job.tenant_id, job.space_id, job.document_id, job.job_id, job.kind, job.page_start, job.page_end, job.status, job.attempt_count, job.attempt_limit, job.lease_token, job.lease_owner, job.lease_expires_at, job.available_at, job.error_code, job.error_message, job.completed_at, job.created_at, job.updated_at;

-- name: GetPresentingRenderJobDocument :one
select
    document.tenant_id, document.space_id, document.episode_id, document.document_id, document.attachment_id,
    document.file_name, document.mime_type, document.byte_length, document.source_object_key, document.source_sha256,
    document.status, document.failure_code, document.failure_message, document.page_count, document.created_at, document.updated_at
from presenting_documents document
where document.tenant_id = sqlc.arg(tenant_id)
    and document.space_id = sqlc.arg(space_id)
    and document.document_id = sqlc.arg(document_id);

-- name: HeartbeatPresentingRenderJob :execrows
update presenting_render_jobs
set lease_expires_at = sqlc.arg(lease_expires_at), updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and document_id = sqlc.arg(document_id)
    and job_id = sqlc.arg(job_id)
    and status = 'leased'
    and attempt_count = sqlc.arg(attempt_count)
    and lease_owner = sqlc.arg(lease_owner)
    and lease_token = sqlc.arg(lease_token)
    and lease_expires_at > sqlc.arg(now_at);

-- name: CompletePresentingRenderJob :execrows
update presenting_render_jobs
set status = 'succeeded', completed_at = now(), lease_expires_at = null, updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and document_id = sqlc.arg(document_id)
    and job_id = sqlc.arg(job_id)
    and attempt_count = sqlc.arg(attempt_count)
    and lease_owner = sqlc.arg(lease_owner)
    and lease_token = sqlc.arg(lease_token)
    and status in ('leased', 'succeeded');

-- name: FailPresentingRenderJob :execrows
update presenting_render_jobs
set status = 'failed', error_code = sqlc.arg(error_code), error_message = sqlc.arg(error_message), completed_at = now(), lease_expires_at = null, updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and document_id = sqlc.arg(document_id)
    and job_id = sqlc.arg(job_id)
    and attempt_count = sqlc.arg(attempt_count)
    and lease_owner = sqlc.arg(lease_owner)
    and lease_token = sqlc.arg(lease_token)
    and status in ('leased', 'failed');

-- name: InsertPresentingDocumentPage :exec
insert into presenting_document_pages (tenant_id, space_id, document_id, page, width, height, status)
values (sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(document_id), sqlc.arg(page), sqlc.arg(width), sqlc.arg(height), 'pending')
on conflict (tenant_id, space_id, document_id, page) do nothing;

-- name: SetPresentingDocumentInventory :execrows
update presenting_documents
set page_count = sqlc.arg(page_count), updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and document_id = sqlc.arg(document_id)
    and status = 'preparing';

-- name: MarkPresentingPageReady :execrows
update presenting_document_pages
set status = 'ready', updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and document_id = sqlc.arg(document_id)
    and page = sqlc.arg(page);

-- name: MarkPresentingZoomReady :execrows
update presenting_document_pages
set zoom_ready_at = sqlc.arg(zoom_ready_at), updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and document_id = sqlc.arg(document_id)
    and page = sqlc.arg(page)
    and status = 'ready';

-- name: FailPresentingDocument :execrows
update presenting_documents
set status = 'failed', failure_code = sqlc.arg(failure_code), failure_message = sqlc.arg(failure_message), updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and document_id = sqlc.arg(document_id)
    and status <> 'failed';

-- name: CountPresentingReadyPages :one
select count(*)::integer
from presenting_document_pages
where tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and document_id = sqlc.arg(document_id)
    and status = 'ready';

-- name: CompletePresentingDocumentIfReady :execrows
update presenting_documents
set status = 'ready', updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and document_id = sqlc.arg(document_id)
    and status = 'preparing'
    and page_count is not null
    and page_count = sqlc.arg(ready_pages);

-- name: ListPresentingPageRanges :many
select page
from presenting_document_pages
where tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and document_id = sqlc.arg(document_id)
    and page >= sqlc.arg(page_start)
    and page <= sqlc.arg(page_end)
order by page;

-- name: ListExpiredPresentingDocuments :many
select document.tenant_id, document.space_id, document.document_id
from presenting_documents document
join episodes episode
    on episode.tenant_id = document.tenant_id
    and episode.space_id = document.space_id
    and episode.id = document.episode_id
left join sync_chat_attachments attachment
    on attachment.tenant_id = document.tenant_id
    and attachment.space_id = document.space_id
    and attachment.attachment_id = document.attachment_id
where (
    attachment.attachment_id is null
    or (attachment.status <> 'attached' and attachment.expires_at <= sqlc.arg(now_at))
    or (episode.status = 'ended' and episode.ended_at <= sqlc.arg(ended_before))
)
order by document.created_at, document.document_id
limit sqlc.arg(batch_limit);

-- name: DeletePresentingDocument :execrows
delete from presenting_documents
where tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and document_id = sqlc.arg(document_id);
