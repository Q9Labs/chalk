package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func verifyDataset(ctx context.Context, value dataset, options options) (report, error) {
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
		return report{}, errors.New("chalk showcase registry does not exist; apply must complete before verify")
	}
	if registry.State != "applied" || registry.OrganizationID.String() != ids.OrganizationID || !bytesEqual(registry.ManifestHash, value.ManifestHash[:]) || !bytesEqual(registry.AssetsHash, value.AssetsHash[:]) {
		return report{}, errors.New("chalk showcase registry is not the expected applied deterministic dataset")
	}
	if err := registryMatchesDataset(value, registry); err != nil {
		return report{}, err
	}
	if options.organizationID != "" && options.organizationID != registry.OrganizationID.String() {
		return report{}, fmt.Errorf("--organization-id %s does not match registry organization %s", options.organizationID, registry.OrganizationID)
	}
	if err := verifyDatabase(ctx, pool, value, ids, registry); err != nil {
		return report{}, err
	}
	if err := verifyBuiltAssets(ctx, value, options.skipStorageVerify); err != nil {
		return report{}, err
	}
	result := baseReport(value, options, "verify")
	result.OrganizationID = registry.OrganizationID.String()
	result.Status = "verified"
	result.Message = "verified native Chalk relations, reducer control snapshots, available artifacts, and built asset objects; pending capture slots are not artifact references"
	return result, nil
}

func verifyDatabase(ctx context.Context, pool *pgxpool.Pool, value dataset, ids datasetIDs, registry registryRecord) error {
	tenantIDs := stringIDs(ids.TenantIDs)
	episodeIDs := stringIDs(ids.EpisodeIDs)
	spaceIDs := stringIDs(ids.SpaceIDs)
	userIDs := stringIDs(ids.UserIDs)
	identityIDs := stringIDs(ids.IdentityIDs)
	expected := map[string]int{
		"tenants":        len(value.Manifest.Records.Tenants),
		"spaces":         len(value.Manifest.Records.Spaces),
		"users":          len(value.Manifest.Records.Users),
		"identities":     len(value.Manifest.Records.Users) + len(value.Manifest.Records.Agents),
		"episodes":       len(value.Manifest.Records.Episodes),
		"participants":   len(value.Manifest.Records.Episodes) * 5,
		"spaceMembers":   expectedSpaceMemberCount(value),
		"memberships":    len(value.Manifest.Records.Users) + len(value.Manifest.Records.Tenants),
		"chatStreams":    len(value.Manifest.Records.Spaces),
		"chatMessages":   len(value.Manifest.Records.Episodes) * 4,
		"whiteboards":    len(value.Manifest.Records.Episodes),
		"whiteElements":  len(value.Manifest.Records.Episodes) * 6,
		"permissions":    len(value.Manifest.Records.Episodes) * 5,
		"controls":       len(value.Manifest.Records.Episodes),
		"controlEvents":  len(value.Manifest.Records.Episodes) * 6,
		"lifecycle":      len(value.Manifest.Records.Episodes) * 6,
		"recordings":     27,
		"transcriptions": 27,
	}
	queries := []struct {
		name  string
		want  int
		query string
		args  []any
	}{
		{"tenants", expected["tenants"], `select count(*) from tenants where id = any($1::uuid[])`, []any{tenantIDs}},
		{"spaces", expected["spaces"], `select count(*) from spaces where id = any($1::uuid[])`, []any{spaceIDs}},
		{"users", expected["users"], `select count(*) from users where id = any($1::uuid[])`, []any{userIDs}},
		{"identities", expected["identities"], `select count(*) from identities where id = any($1::uuid[])`, []any{identityIDs}},
		{"episodes", expected["episodes"], `select count(*) from episodes where id = any($1::uuid[])`, []any{episodeIDs}},
		{"participants", expected["participants"], `select count(*) from participants where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"spaceMembers", expected["spaceMembers"], `select count(*) from space_members where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"memberships", expected["memberships"], `select count(*) from memberships where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"chatStreams", expected["chatStreams"], `select count(*) from sync_chat_streams where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"chatMessages", expected["chatMessages"], `select count(*) from sync_chat_messages where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"whiteboards", expected["whiteboards"], `select count(*) from sync_whiteboard_scenes where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"whiteElements", expected["whiteElements"], `select count(*) from sync_whiteboard_elements where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"permissions", expected["permissions"], `select count(*) from sync_whiteboard_permissions where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"controls", expected["controls"], `select count(*) from sync_episode_control where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"controlEvents", expected["controlEvents"], `select count(*) from sync_control_events where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"lifecycle", expected["lifecycle"], `select count(*) from sync_lifecycle_intents where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"recordings", expected["recordings"], `select count(*) from recordings where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"transcriptions", expected["transcriptions"], `select count(*) from transcriptions where tenant_id = any($1::uuid[])`, []any{tenantIDs}},
		{"availableRecordings", 12, `select count(*) from recordings where tenant_id = any($1::uuid[]) and status = 'completed' and storage_key is not null`, []any{tenantIDs}},
		{"unavailableRecordings", 15, `select count(*) from recordings where tenant_id = any($1::uuid[]) and status = 'failed' and storage_key is null`, []any{tenantIDs}},
	}
	var failures []error
	for _, check := range queries {
		var count int
		if err := pool.QueryRow(ctx, check.query, check.args...).Scan(&count); err != nil {
			failures = append(failures, fmt.Errorf("count %s: %w", check.name, err))
			continue
		}
		if count != check.want {
			failures = append(failures, fmt.Errorf("count %s: got %d want %d", check.name, count, check.want))
		}
	}
	if err := verifyTenantRows(ctx, pool, value, ids, registry); err != nil {
		failures = append(failures, err)
	}
	if err := verifyEpisodeRows(ctx, pool, value, ids); err != nil {
		failures = append(failures, err)
	}
	if len(failures) > 0 {
		return errors.Join(failures...)
	}
	return nil
}

func verifyTenantRows(ctx context.Context, pool *pgxpool.Pool, value dataset, ids datasetIDs, registry registryRecord) error {
	var failures []error
	for _, item := range value.Manifest.Records.Tenants {
		var name, logoKey string
		if err := pool.QueryRow(ctx, `select name, coalesce(logo_key, '') from tenants where id = $1`, uuid.MustParse(ids.TenantIDs[item.ExternalKey])).Scan(&name, &logoKey); err != nil {
			failures = append(failures, fmt.Errorf("tenant %s: %w", item.ExternalKey, err))
			continue
		}
		if name != item.DisplayName {
			failures = append(failures, fmt.Errorf("tenant %s name mismatch", item.ExternalKey))
		}
		if logoKey != value.AssetByKey["chalk/catalog/organization-scene"].StorageKey {
			failures = append(failures, fmt.Errorf("tenant %s logo relation mismatch", item.ExternalKey))
		}
	}
	if len(failures) > 0 {
		return errors.Join(failures...)
	}
	return nil
}

func verifyEpisodeRows(ctx context.Context, pool *pgxpool.Pool, value dataset, ids datasetIDs) error {
	var failures []error
	for _, item := range value.Manifest.Records.Episodes {
		var status, metadata string
		if err := pool.QueryRow(ctx, `select status, metadata::text from episodes where id = $1`, uuid.MustParse(ids.EpisodeIDs[item.ExternalKey])).Scan(&status, &metadata); err != nil {
			failures = append(failures, fmt.Errorf("episode %s: %w", item.ExternalKey, err))
			continue
		}
		if status != "ended" {
			failures = append(failures, fmt.Errorf("episode %s is %s, want ended", item.ExternalKey, status))
		}
		var episodeMetadata struct {
			ShowcaseDatasetID  string `json:"showcaseDatasetId"`
			ExternalKey        string `json:"externalKey"`
			AgentKey           string `json:"agentKey"`
			PendingArtifact    bool   `json:"pendingArtifactCapture"`
			PendingArtifactNum int    `json:"pendingArtifactCount"`
			Reactions          []struct {
				UserKey       string `json:"userKey"`
				ParticipantID string `json:"participantId"`
				Kind          string `json:"kind"`
			} `json:"reactionHistory"`
			AvailableArtifactRefs map[string]json.RawMessage `json:"availableArtifactRefs"`
		}
		if err := json.Unmarshal([]byte(metadata), &episodeMetadata); err != nil {
			failures = append(failures, fmt.Errorf("episode %s metadata is invalid: %w", item.ExternalKey, err))
			continue
		}
		if episodeMetadata.ShowcaseDatasetID != showcaseDatasetID || episodeMetadata.ExternalKey != item.ExternalKey || episodeMetadata.AgentKey != item.AgentKey || len(episodeMetadata.Reactions) != len(item.Reactions) {
			failures = append(failures, fmt.Errorf("episode %s is missing its native showcase metadata", item.ExternalKey))
		}
		if episodeMetadata.PendingArtifact != item.Flagship || episodeMetadata.PendingArtifactNum != boolInt(item.Flagship, 3) {
			failures = append(failures, fmt.Errorf("episode %s pending artifact marker mismatch", item.ExternalKey))
		}
		for index, reaction := range item.Reactions {
			if index >= len(episodeMetadata.Reactions) {
				break
			}
			actual := episodeMetadata.Reactions[index]
			if actual.UserKey != reaction.UserKey || actual.Kind != reaction.Kind || actual.ParticipantID != participantID(ids, item.ExternalKey, reaction.UserKey).String() {
				failures = append(failures, fmt.Errorf("episode %s reaction %d relation mismatch", item.ExternalKey, index+1))
			}
		}
		for pendingKey := range value.PendingAssetKeys {
			if strings.Contains(metadata, pendingKey) {
				failures = append(failures, fmt.Errorf("episode %s exposes pending asset %s", item.ExternalKey, pendingKey))
			}
		}
	}
	var availableRefs int
	if err := pool.QueryRow(ctx, `
		select count(*) from episodes
		where tenant_id = any($1::uuid[])
		and jsonb_typeof(metadata -> 'availableArtifactRefs') = 'object'
		and metadata -> 'availableArtifactRefs' <> '{}'::jsonb
	`, stringIDs(ids.TenantIDs)).Scan(&availableRefs); err != nil {
		return fmt.Errorf("count available Episode artifact references: %w", err)
	}
	if availableRefs != 27 {
		failures = append(failures, fmt.Errorf("available Episode artifact references: got %d want 27", availableRefs))
	}
	if len(failures) > 0 {
		return errors.Join(failures...)
	}
	return nil
}

func expectedSpaceMemberCount(value dataset) int {
	count := 0
	for _, item := range value.Manifest.Records.Spaces {
		for _, userValue := range value.Manifest.Records.Users {
			if userValue.TenantKey == item.TenantKey {
				count++
			}
		}
		for _, agentValue := range value.Manifest.Records.Agents {
			if agentValue.TenantKey == item.TenantKey {
				count++
			}
		}
	}
	return count
}
