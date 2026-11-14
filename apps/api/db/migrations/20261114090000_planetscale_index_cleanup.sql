-- +goose NO TRANSACTION
-- +goose Up
-- PlanetScale's weekly recommendations, checked against the code. Each dropped index serves no
-- query: its table is read by another index, or only written. The running release keeps writing
-- these tables while this applies, so every statement is concurrent and commits on its own, and a
-- run that stops early runs again safely.
-- chalk:removed-in #1386
drop index concurrently if exists api_key_mutation_requests_resource_idx;
drop index concurrently if exists identities_tenant_created_at_id_idx;
drop index concurrently if exists participants_dashboard_account_space_idx;
drop index concurrently if exists provider_operation_receipts_reconciliation_idx;
drop index concurrently if exists space_roles_space_created_at_id_idx;
drop index concurrently if exists space_public_invites_handle_idx;
drop index concurrently if exists recording_transcription_source_chunks_recording_idx;
drop index concurrently if exists transcript_chunks_transcript_idx;
drop index concurrently if exists recording_bundles_recording_sequence_idx;
drop index concurrently if exists webhook_delivery_attempts_delivery_idx;
drop index concurrently if exists provider_operation_observations_episode_cursor_idx;

-- ClaimTranscriptionCleanupJob looks for leased jobs whose lease expired. Only those rows are in
-- the index, so it stays tiny while the table grows. An earlier run's leftover is dropped first.
drop index concurrently if exists transcription_cleanup_jobs_lease_idx;
create index concurrently transcription_cleanup_jobs_lease_idx
    on transcription_cleanup_jobs (lease_expires_at)
    where state = 'leased';

-- +goose Down
drop index concurrently if exists transcription_cleanup_jobs_lease_idx;

create index concurrently if not exists api_key_mutation_requests_resource_idx
    on api_key_mutation_requests (tenant_id, api_key_id) where api_key_id is not null;
create index concurrently if not exists identities_tenant_created_at_id_idx
    on identities (tenant_id, created_at desc, id desc);
create index concurrently if not exists participants_dashboard_account_space_idx
    on participants (tenant_id, space_id, account_id, created_at desc) where account_id is not null;
create index concurrently if not exists provider_operation_receipts_reconciliation_idx
    on provider_operation_receipts (state, created_at, operation_id, effect)
    where state in ('prepared', 'dispatching');
create index concurrently if not exists space_roles_space_created_at_id_idx
    on space_roles (space_id, created_at desc, id desc);
create index concurrently if not exists space_public_invites_handle_idx
    on space_public_invites (handle);
create index concurrently if not exists recording_transcription_source_chunks_recording_idx
    on recording_transcription_source_chunks (recording_id, generation, chunk_index);
create index concurrently if not exists transcript_chunks_transcript_idx
    on transcript_chunks (transcript_id, generation, chunk_index);
create index concurrently if not exists recording_bundles_recording_sequence_idx
    on recording_bundles (recording_id, sequence_number);
create index concurrently if not exists webhook_delivery_attempts_delivery_idx
    on webhook_delivery_attempts (tenant_id, delivery_id, attempt_number);
create index concurrently if not exists provider_operation_observations_episode_cursor_idx
    on provider_operation_observations (tenant_id, episode_id, incarnation, sequence);
