-- +goose Up
-- +goose StatementBegin
create function can_reserve_whiteboard_file(
    scope_tenant uuid, scope_space uuid, scope_scene uuid, caller uuid, requested_file_id text
) returns boolean language plpgsql volatile as $$
declare
    allowed boolean;
begin
    -- Reservation requests serialize before taking a fresh count. Cleanup and
    -- attaching images can only reduce that count and never take this lock.
    perform pg_advisory_xact_lock(hashtextextended('whiteboard-file-admission', 0));
    if exists (
        select 1 from sync_whiteboard_files
        where (tenant_id, space_id, scene_id, file_id) = (scope_tenant, scope_space, scope_scene, requested_file_id)
    ) then
        return true;
    end if;

    -- Count pending, expired, claimed and ready orphans alike. At 20 MiB per
    -- object this caps orphan exposure at 160 MiB per drawer, 640 MiB per
    -- tenant and 3.125 GiB overall (160 rows vs. 200 per cleanup pass).
    select count(*) < 160
        and count(*) filter (where tenant_id = scope_tenant) < 32
        and count(*) filter (where tenant_id = scope_tenant and participant_id = caller) < 8
    into allowed
    from sync_whiteboard_files where referenced_at is null;

    return allowed;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function reference_committed_whiteboard_image() returns trigger language plpgsql as $$
declare
    file sync_whiteboard_files%rowtype;
begin
    -- Take the file lock even if our snapshot still shows a pending upload.
    -- Once finalize or cleanup commits, the locked row (or its absence)
    -- decides whether this reference can commit, including on older Sync.
    select uploads.* into file
    from sync_whiteboard_files uploads
    where (uploads.tenant_id, uploads.space_id, uploads.episode_id, uploads.scene_id, uploads.file_id) =
        (new.tenant_id, new.space_id, new.episode_id, new.scene_id, new.payload->>'fileId')
    for no key update;

    if not found or file.status <> 'ready' or file.cleanup_claim_token is not null then
        raise check_violation using message = 'whiteboard image requires a ready, unclaimed file';
    end if;

    if file.referenced_at is null then
        update sync_whiteboard_files set referenced_at = now() where upload_id = file.upload_id;
    end if;
    return null;
end;
$$;
-- +goose StatementEnd

-- Current Sync validates files itself after writing elements. Do not replace
-- its invalid-payload result with a database error from the element write.
create constraint trigger reference_committed_whiteboard_image
    after insert or update of payload, is_deleted on sync_whiteboard_elements
    deferrable initially deferred
    for each row when (new.element_type = 'image' and not new.is_deleted
        and new.payload->>'status' = 'saved' and new.payload->>'fileId' is not null)
    execute function reference_committed_whiteboard_image();

-- Sync writes elements before referencing files. Install the trigger before
-- taking a files-table lock for the index or the reference backfill.
create index sync_whiteboard_files_unreferenced_idx
    on sync_whiteboard_files (tenant_id, participant_id)
    where referenced_at is null;

-- Existing elements can have been committed by older Sync before this migration.
update sync_whiteboard_files file
set referenced_at = now()
where file.status = 'ready' and file.referenced_at is null and file.cleanup_claim_token is null
  and exists (
      select 1 from sync_whiteboard_elements element
      where (element.tenant_id, element.space_id, element.episode_id, element.scene_id, element.payload->>'fileId') =
          (file.tenant_id, file.space_id, file.episode_id, file.scene_id, file.file_id)
        and element.element_type = 'image'
  );

-- +goose Down
drop trigger reference_committed_whiteboard_image on sync_whiteboard_elements;
drop function reference_committed_whiteboard_image();
drop function can_reserve_whiteboard_file(uuid, uuid, uuid, uuid, text);
drop index sync_whiteboard_files_unreferenced_idx;
