package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func removeDataset(ctx context.Context, value dataset, options options) (report, error) {
	ids := buildIDs(value)
	pool, err := openPool(ctx, options.databaseURL)
	if err != nil {
		return report{}, err
	}
	defer pool.Close()
	registry, exists, err := loadRegistry(ctx, pool, options.organizationKey)
	if err != nil {
		return report{}, err
	}
	if !exists {
		return report{}, errors.New("chalk showcase registry does not exist; there is nothing to remove")
	}
	if (registry.State != "applied" && registry.State != "removing") || registry.OrganizationID.String() != ids.OrganizationID {
		return report{}, errors.New("chalk showcase registry is not the expected applied or removing deterministic dataset")
	}
	if err := registryMatchesDataset(value, registry); err != nil {
		return report{}, err
	}
	if options.confirmOrganization != registry.OrganizationID.String() {
		return report{}, fmt.Errorf("--confirm-organization must equal %s", registry.OrganizationID)
	}
	if err := beginRegistryRemoval(ctx, pool, options.organizationKey, uuid.MustParse(ids.OrganizationID)); err != nil {
		return report{}, err
	}
	if err := deleteBuiltAssets(ctx, value, options.skipStorageDelete); err != nil {
		return report{}, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return report{}, fmt.Errorf("begin Chalk showcase removal: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := deleteShowcaseRows(ctx, tx, ids); err != nil {
		return report{}, err
	}
	if _, err := tx.Exec(ctx, `
		delete from showcase_dataset_registries
		where dataset_id = $1 and product = $2 and organization_key = $3
	`, showcaseDatasetID, showcaseProduct, options.organizationKey); err != nil {
		return report{}, fmt.Errorf("delete Chalk showcase registry: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return report{}, fmt.Errorf("commit Chalk showcase removal: %w", err)
	}

	result := baseReport(value, options, "remove")
	result.OrganizationID = registry.OrganizationID.String()
	result.Status = "removed"
	result.Message = "removed the deterministic Chalk showcase organization boundary and its built asset objects; existing customer tenants were not touched"
	return result, nil
}

func deleteShowcaseRows(ctx context.Context, tx pgx.Tx, ids datasetIDs) error {
	tenantIDs := stringIDs(ids.TenantIDs)
	userIDs := stringIDs(ids.UserIDs)
	statements := []struct {
		description string
		query       string
		args        []any
	}{
		{"whiteboard files", `delete from sync_whiteboard_files where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"whiteboard operation receipts", `delete from sync_whiteboard_operation_receipts where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"whiteboard permissions", `delete from sync_whiteboard_permissions where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"whiteboard elements", `delete from sync_whiteboard_elements where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"whiteboard scenes", `delete from sync_whiteboard_scenes where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"chat read receipts", `delete from sync_chat_read_receipts where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"chat attachments", `delete from sync_chat_attachments where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"chat messages", `delete from sync_chat_messages where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"chat streams", `delete from sync_chat_streams where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"command receipts", `delete from sync_command_receipts where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"admission requests", `delete from sync_admission_requests where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"screen-share leases", `delete from sync_screen_share_leases where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"publication fences", `delete from sync_publication_fences where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"publication reservations", `delete from sync_publication_grant_reservations where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"sync recordings", `delete from sync_recordings where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"lifecycle intent event links", `update sync_lifecycle_intents set status = 'pending', applied_event_id = null, applied_revision = null, completed_at = null where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"control events", `delete from sync_control_events where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"lifecycle intents", `delete from sync_lifecycle_intents where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"episode controls", `delete from sync_episode_control where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"transcription cleanup jobs", `delete from transcription_cleanup_jobs where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"transcription chunk results", `delete from transcription_chunk_results where chunk_id in (select chunk.id from transcript_chunks chunk where chunk.tenant_id = any($1::uuid[]))`, []any{tenantIDs}},
		{"transcription attempts", `delete from transcription_attempts where chunk_id in (select chunk.id from transcript_chunks chunk where chunk.tenant_id = any($1::uuid[]))`, []any{tenantIDs}},
		{"transcript chunks", `delete from transcript_chunks where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"recording transcription source chunks", `delete from recording_transcription_source_chunks where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"recording transcription sources", `delete from recording_transcription_sources where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"transcriptions", `delete from transcriptions where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"recording artifacts", `delete from recording_artifacts where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"recording bundles", `delete from recording_bundles where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"recording jobs", `delete from recording_jobs where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"recording pipelines", `delete from recording_pipelines where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"recording reservations", `delete from recording_reservations where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"recordings", `delete from recordings where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"audit logs", `delete from audit_logs where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"episode create requests", `delete from episode_create_requests where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"participants", `delete from participants where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"episodes", `delete from episodes where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"space arrivals", `delete from space_public_arrivals where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"space public invites", `delete from space_public_invites where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"space create requests", `delete from space_create_requests where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"space members", `delete from space_members where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"space roles", `delete from space_roles where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"spaces", `delete from spaces where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"memberships", `delete from memberships where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"identities", `delete from identities where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"users", `delete from users where id = any($1::uuid[])`, []any{userIDs}},
		{"tenants", `delete from tenants where id = any($1::uuid[])`, []any{tenantIDs}},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			return fmt.Errorf("delete %s: %w", statement.description, err)
		}
	}
	return nil
}
