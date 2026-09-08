package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type episodeSeed struct {
	Item         episode
	TenantID     uuid.UUID
	SpaceID      uuid.UUID
	EpisodeID    uuid.UUID
	Participants []seedParticipant
}

type seedParticipant struct {
	IdentityKey   string
	ParticipantID uuid.UUID
	IdentityID    uuid.UUID
	DisplayName   string
	Role          string
	Capabilities  []string
	AccountID     any
}

func applyDataset(ctx context.Context, value dataset, options options) (report, error) {
	ids := buildIDs(value)
	ownerID, err := uuid.Parse(options.ownerUserID)
	if err != nil {
		return report{}, fmt.Errorf("parse owner user id: %w", err)
	}
	pool, err := openPool(ctx, options.databaseURL)
	if err != nil {
		return report{}, err
	}
	defer pool.Close()

	registry, exists, err := loadRegistry(ctx, pool, options.organizationKey)
	if err != nil {
		return report{}, err
	}
	if exists {
		if registry.State == "removing" {
			return report{}, errors.New("chalk showcase removal is in progress; retry remove before applying this organization")
		}
		if registry.OrganizationID.String() != ids.OrganizationID || registry.OwnerUserID != ownerID || registry.State != "applied" || !bytesEqual(registry.ManifestHash, value.ManifestHash[:]) || !bytesEqual(registry.AssetsHash, value.AssetsHash[:]) {
			return report{}, fmt.Errorf("existing Chalk showcase registry for %s does not match this deterministic apply", options.organizationKey)
		}
		if err := registryMatchesDataset(value, registry); err != nil {
			return report{}, err
		}
		if err := verifyDatabase(ctx, pool, value, ids, registry); err != nil {
			return report{}, fmt.Errorf("existing showcase registry is not complete: %w", err)
		}
		result := baseReport(value, options, "apply")
		result.OrganizationID = registry.OrganizationID.String()
		result.Status = "already-applied"
		result.Message = "the deterministic Chalk showcase organization is already applied"
		return result, nil
	}
	if err := ensureOwner(ctx, pool, ownerID); err != nil {
		return report{}, err
	}
	if err := ensureFreshIDs(ctx, pool, ids); err != nil {
		return report{}, err
	}
	if err := uploadBuiltAssets(ctx, value, options.assetRoot, options.skipAssetUpload); err != nil {
		return report{}, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return report{}, fmt.Errorf("begin Chalk showcase transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := insertRegistry(ctx, tx, value, ids, ownerID); err != nil {
		return report{}, err
	}
	if err := seedTenants(ctx, tx, value, ids); err != nil {
		return report{}, err
	}
	if err := seedUsers(ctx, tx, value, ids, ownerID); err != nil {
		return report{}, err
	}
	if err := seedIdentities(ctx, tx, value, ids); err != nil {
		return report{}, err
	}
	if err := seedSpaces(ctx, tx, value, ids, ownerID); err != nil {
		return report{}, err
	}
	applyClock := time.Now().UTC()
	seeds, err := seedEpisodes(ctx, tx, value, ids, ownerID, applyClock)
	if err != nil {
		return report{}, err
	}
	if err := seedChats(ctx, tx, value, ids, seeds); err != nil {
		return report{}, err
	}
	if err := seedArtifacts(ctx, tx, value, ids, seeds); err != nil {
		return report{}, err
	}
	if err := markRegistryApplied(ctx, tx, options.organizationKey); err != nil {
		return report{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return report{}, fmt.Errorf("commit Chalk showcase transaction: %w", err)
	}

	result := baseReport(value, options, "apply")
	result.OrganizationID = ids.OrganizationID
	result.Status = "applied"
	result.Message = "created the new Chalk showcase organization boundary with native tenant, Space, Episode, Participant, Agent, chat, reaction, whiteboard, and available artifact relations"
	return result, nil
}

func seedUsers(ctx context.Context, tx pgx.Tx, value dataset, ids datasetIDs, ownerID uuid.UUID) error {
	for _, item := range value.Manifest.Records.Users {
		userID := uuid.MustParse(ids.UserIDs[item.ExternalKey])
		if _, err := tx.Exec(ctx, `
			insert into users (id, name, email)
			values ($1, $2, $3)
		`, userID, item.DisplayNameEN, item.ExternalKey+"@chalk-showcase.invalid"); err != nil {
			return fmt.Errorf("insert showcase user %s: %w", item.ExternalKey, err)
		}
	}
	for _, item := range value.Manifest.Records.Tenants {
		tenantID := uuid.MustParse(ids.TenantIDs[item.ExternalKey])
		membershipID := deterministicID("membership", item.ExternalKey+"/owner")
		if _, err := tx.Exec(ctx, `
			insert into memberships (id, tenant_id, user_id, role)
			values ($1, $2, $3, 'owner')
		`, membershipID, tenantID, ownerID); err != nil {
			return fmt.Errorf("insert owner membership for %s: %w", item.ExternalKey, err)
		}
		for _, userValue := range value.Manifest.Records.Users {
			if userValue.TenantKey != item.ExternalKey {
				continue
			}
			role := identityRole(userValue.Role)
			userID := uuid.MustParse(ids.UserIDs[userValue.ExternalKey])
			membershipID := deterministicID("membership", item.ExternalKey+"/"+userValue.ExternalKey)
			if _, err := tx.Exec(ctx, `
				insert into memberships (id, tenant_id, user_id, role)
				values ($1, $2, $3, $4)
			`, membershipID, tenantID, userID, role); err != nil {
				return fmt.Errorf("insert membership for %s: %w", userValue.ExternalKey, err)
			}
		}
	}
	return nil
}

func seedTenants(ctx context.Context, tx pgx.Tx, value dataset, ids datasetIDs) error {
	logoKey := value.AssetByKey["chalk/catalog/organization-scene"].StorageKey
	storageConfig := map[string]any{
		"enabled":  true,
		"provider": "cloudflare_r2",
		"mode":     "chalk_managed",
		"prefix":   "showcase-v1/chalk/",
	}
	for _, item := range value.Manifest.Records.Tenants {
		tenantID := uuid.MustParse(ids.TenantIDs[item.ExternalKey])
		encodedConfig, err := json.Marshal(storageConfig)
		if err != nil {
			return fmt.Errorf("encode storage config: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			insert into tenants (
				id, name, default_region, default_media_plane,
				storage_provider_config, logo_key, website
			)
			values ($1, $2, 'us-east-1', 'cf_rtk', $3::jsonb, $4, 'https://chalkmeet.com')
		`, tenantID, item.DisplayName, encodedConfig, logoKey); err != nil {
			return fmt.Errorf("insert showcase tenant %s: %w", item.ExternalKey, err)
		}
	}
	return nil
}

func seedIdentities(ctx context.Context, tx pgx.Tx, value dataset, ids datasetIDs) error {
	for _, item := range value.Manifest.Records.Users {
		metadata, err := json.Marshal(map[string]any{
			"showcaseDatasetId": showcaseDatasetID,
			"datasetVersion":    showcaseDatasetVersion,
			"externalKey":       item.ExternalKey,
			"locale":            item.Locale,
			"role":              item.Role,
			"displayNameAr":     item.DisplayNameAR,
		})
		if err != nil {
			return fmt.Errorf("encode user identity metadata %s: %w", item.ExternalKey, err)
		}
		if _, err := tx.Exec(ctx, `
			insert into identities (id, tenant_id, kind, external_id, display_name, metadata)
			values ($1, $2, 'user', $3, $4, $5::jsonb)
		`, uuid.MustParse(ids.IdentityIDs[item.ExternalKey]), uuid.MustParse(ids.TenantIDs[item.TenantKey]), item.ExternalKey, item.DisplayNameEN, metadata); err != nil {
			return fmt.Errorf("insert user identity %s: %w", item.ExternalKey, err)
		}
	}
	for _, item := range value.Manifest.Records.Agents {
		metadata, err := json.Marshal(map[string]any{
			"showcaseDatasetId": showcaseDatasetID,
			"datasetVersion":    showcaseDatasetVersion,
			"externalKey":       item.ExternalKey,
			"permission":        item.Permission,
			"nativeAgent":       true,
		})
		if err != nil {
			return fmt.Errorf("encode Agent identity metadata %s: %w", item.ExternalKey, err)
		}
		if _, err := tx.Exec(ctx, `
			insert into identities (id, tenant_id, kind, external_id, display_name, metadata)
			values ($1, $2, 'agent', $3, $4, $5::jsonb)
		`, uuid.MustParse(ids.AgentIDs[item.ExternalKey]), uuid.MustParse(ids.TenantIDs[item.TenantKey]), item.ExternalKey, item.Name, metadata); err != nil {
			return fmt.Errorf("insert Agent identity %s: %w", item.ExternalKey, err)
		}
	}
	return nil
}

func seedSpaces(ctx context.Context, tx pgx.Tx, value dataset, ids datasetIDs, ownerID uuid.UUID) error {
	capabilities := roleCapabilities()
	for _, item := range value.Manifest.Records.Spaces {
		tenantID := uuid.MustParse(ids.TenantIDs[item.TenantKey])
		spaceID := uuid.MustParse(ids.SpaceIDs[item.ExternalKey])
		admissionMode := admissionPolicy(item)
		admissionPolicyJSON, err := json.Marshal(map[string]string{"mode": admissionMode})
		if err != nil {
			return fmt.Errorf("encode admission policy %s: %w", item.ExternalKey, err)
		}
		metadata, err := json.Marshal(map[string]any{
			"showcaseDatasetId": showcaseDatasetID,
			"datasetVersion":    showcaseDatasetVersion,
			"externalKey":       item.ExternalKey,
			"organizationKey":   item.OrganizationKey,
			"tenantKey":         item.TenantKey,
			"visibility":        item.Visibility,
			"nativeSeed":        true,
		})
		if err != nil {
			return fmt.Errorf("encode Space metadata %s: %w", item.ExternalKey, err)
		}
		if _, err := tx.Exec(ctx, `
			insert into spaces (
				id, name, tenant_id, slug, media_plane, metadata,
				admission_policy, default_episode_duration_seconds,
				maximum_episode_duration_seconds, linger_window_seconds,
				created_by_user_id
			)
			values ($1, $2, $3, $4, 'cf_rtk', $5::jsonb, $6::jsonb, 3600, 86400, 0, $7)
		`, spaceID, item.Name, tenantID, spaceSlug(item.ExternalKey), metadata,
			admissionPolicyJSON, ownerID); err != nil {
			return fmt.Errorf("insert showcase Space %s: %w", item.ExternalKey, err)
		}
		for _, role := range []string{"owner", "collaborator", "observer"} {
			roleID := deterministicID("space-role", item.ExternalKey+"/"+role)
			if _, err := tx.Exec(ctx, `
				insert into space_roles (id, tenant_id, space_id, name, capabilities)
				values ($1, $2, $3, $4, $5)
			`, roleID, tenantID, spaceID, role, capabilities[role]); err != nil {
				return fmt.Errorf("insert %s role for %s: %w", role, item.ExternalKey, err)
			}
		}
		handle := sha256.Sum256([]byte("chalk/showcase-v1/invite/" + item.ExternalKey))
		if _, err := tx.Exec(ctx, `
			insert into space_public_invites (
				tenant_id, space_id, handle, generation, state_epoch,
				enabled, public_role, admission_mode, last_actor_id
			)
			values ($1, $2, $3, 1, 1, true, 'collaborator', $4, $5)
		`, tenantID, spaceID, handle[:], admissionMode, ownerID); err != nil {
			return fmt.Errorf("insert public invite for %s: %w", item.ExternalKey, err)
		}
		for _, userValue := range value.Manifest.Records.Users {
			if userValue.TenantKey != item.TenantKey {
				continue
			}
			identityID := uuid.MustParse(ids.IdentityIDs[userValue.ExternalKey])
			roleID := deterministicID("space-role", item.ExternalKey+"/"+identityRole(userValue.Role))
			memberID := deterministicID("space-member", item.ExternalKey+"/"+userValue.ExternalKey)
			if _, err := tx.Exec(ctx, `
				insert into space_members (id, tenant_id, space_id, identity_id, role_id)
				values ($1, $2, $3, $4, $5)
			`, memberID, tenantID, spaceID, identityID, roleID); err != nil {
				return fmt.Errorf("insert user Space member %s: %w", userValue.ExternalKey, err)
			}
		}
		for _, agentValue := range value.Manifest.Records.Agents {
			if agentValue.TenantKey != item.TenantKey {
				continue
			}
			identityID := uuid.MustParse(ids.AgentIDs[agentValue.ExternalKey])
			memberID := deterministicID("space-member", item.ExternalKey+"/"+agentValue.ExternalKey)
			roleID := deterministicID("space-role", item.ExternalKey+"/observer")
			if _, err := tx.Exec(ctx, `
				insert into space_members (id, tenant_id, space_id, identity_id, role_id)
				values ($1, $2, $3, $4, $5)
			`, memberID, tenantID, spaceID, identityID, roleID); err != nil {
				return fmt.Errorf("insert Agent Space member %s: %w", agentValue.ExternalKey, err)
			}
		}
	}
	return nil
}

const (
	episodeRetentionPeriod = 7 * 24 * time.Hour
	episodeRuntimeLead     = 6 * 24 * time.Hour
	episodeRuntimeStep     = 30 * time.Minute
	episodeDuration        = 45 * time.Minute
	episodeDeadline        = 24 * time.Hour
)

func episodeRuntimeTimes(applyClock time.Time, recordIndex int) (startedAt, endedAt, deadlineAt time.Time) {
	startedAt = applyClock.UTC().Add(-episodeRuntimeLead).Add(time.Duration(recordIndex) * episodeRuntimeStep)
	endedAt = startedAt.Add(episodeDuration)
	deadlineAt = startedAt.Add(episodeDeadline)
	return startedAt, endedAt, deadlineAt
}

func seedEpisodes(ctx context.Context, tx pgx.Tx, value dataset, ids datasetIDs, ownerID uuid.UUID, applyClock time.Time) ([]episodeSeed, error) {
	seeds := make([]episodeSeed, 0, len(value.Manifest.Records.Episodes))
	for recordIndex, item := range value.Manifest.Records.Episodes {
		tenantID := uuid.MustParse(ids.TenantIDs[item.TenantKey])
		spaceID := uuid.MustParse(ids.SpaceIDs[item.SpaceKey])
		episodeID := uuid.MustParse(ids.EpisodeIDs[item.ExternalKey])
		startedAt, endedAt, deadlineAt := episodeRuntimeTimes(applyClock, recordIndex)
		runtimeItem := item
		runtimeItem.OccurredAt = startedAt
		participants := make([]seedParticipant, 0, len(item.ParticipantKeys)+1)
		for _, userKey := range item.ParticipantKeys {
			userValue := value.UserByKey[userKey]
			role := participantRole(userValue.Role)
			accountID := uuid.MustParse(ids.UserIDs[userKey])
			participants = append(participants, seedParticipant{
				IdentityKey:   userKey,
				ParticipantID: participantID(ids, item.ExternalKey, userKey),
				IdentityID:    uuid.MustParse(ids.IdentityIDs[userKey]),
				DisplayName:   userValue.DisplayNameEN,
				Role:          role,
				Capabilities:  roleCapabilities()[role],
				AccountID:     accountID,
			})
		}
		agentValue := value.AgentByKey[item.AgentKey]
		participants = append(participants, seedParticipant{
			IdentityKey:   item.AgentKey,
			ParticipantID: participantID(ids, item.ExternalKey, item.AgentKey),
			IdentityID:    uuid.MustParse(ids.AgentIDs[item.AgentKey]),
			DisplayName:   agentValue.Name,
			Role:          "observer",
			Capabilities:  roleCapabilities()["observer"],
		})
		artifactMetadata := buildArtifactMetadata(value, ids, runtimeItem)
		reactionMetadata := buildReactionMetadata(value, ids, runtimeItem)
		metadata, err := buildEpisodeMetadata(ids, runtimeItem, item, agentValue, artifactMetadata, reactionMetadata)
		if err != nil {
			return nil, fmt.Errorf("encode Episode metadata %s: %w", item.ExternalKey, err)
		}
		configSnapshot, err := json.Marshal(map[string]any{
			"roles":                            roleCapabilities(),
			"admission_policy":                 map[string]string{"mode": admissionPolicy(value.SpaceByKey[item.SpaceKey])},
			"default_episode_duration_seconds": 3600,
			"maximum_episode_duration_seconds": 86400,
			"linger_window_seconds":            0,
		})
		if err != nil {
			return nil, fmt.Errorf("encode Episode config %s: %w", item.ExternalKey, err)
		}
		if _, err := tx.Exec(ctx, `
			insert into episodes (
				id, status, metadata, space_id, tenant_id, created_by_user_id,
				started_at, ended_at, config_snapshot, end_reason,
				deadline_at, deadline_generation
			)
			values ($1, 'ended', $2::jsonb, $3, $4, $5, $6, $7, $8::jsonb, 'explicit', $9, 1)
		`, episodeID, metadata, spaceID, tenantID, ownerID, startedAt, endedAt, configSnapshot, deadlineAt); err != nil {
			return nil, fmt.Errorf("insert Episode %s: %w", item.ExternalKey, err)
		}
		for _, participant := range participants {
			participantMetadata, err := json.Marshal(map[string]any{
				"showcaseDatasetId": showcaseDatasetID,
				"datasetVersion":    showcaseDatasetVersion,
				"identityKey":       participant.IdentityKey,
				"kind":              map[bool]string{true: "agent", false: "user"}[participant.AccountID == nil],
			})
			if err != nil {
				return nil, fmt.Errorf("encode participant metadata %s: %w", participant.IdentityKey, err)
			}
			if _, err := tx.Exec(ctx, `
				insert into participants (
					id, name, metadata, capabilities, tenant_id, space_id, episode_id,
					account_id, identity_id, generation, status, role, joined_at, left_at
				)
				values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, 1, 'left', $10, $11, $12)
			`, participant.ParticipantID, participant.DisplayName, participantMetadata, participant.Capabilities,
				tenantID, spaceID, episodeID, participant.AccountID, participant.IdentityID, participant.Role,
				startedAt, endedAt); err != nil {
				return nil, fmt.Errorf("insert participant %s: %w", participant.IdentityKey, err)
			}
		}
		seed := episodeSeed{Item: runtimeItem, TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, Participants: participants}
		if err := seedEpisodeControl(ctx, tx, value, ids, seed); err != nil {
			return nil, err
		}
		if err := seedWhiteboard(ctx, tx, seed); err != nil {
			return nil, err
		}
		seeds = append(seeds, seed)
	}
	return seeds, nil
}

func buildEpisodeMetadata(ids datasetIDs, runtimeItem, manifestItem episode, agentValue agent, artifactMetadata map[string]any, reactionMetadata []map[string]any) ([]byte, error) {
	return json.Marshal(map[string]any{
		"showcaseDatasetId":      showcaseDatasetID,
		"datasetVersion":         showcaseDatasetVersion,
		"externalKey":            runtimeItem.ExternalKey,
		"organizationKey":        runtimeItem.OrganizationKey,
		"tenantKey":              runtimeItem.TenantKey,
		"spaceKey":               runtimeItem.SpaceKey,
		"agentKey":               runtimeItem.AgentKey,
		"agentParticipantId":     participantID(ids, runtimeItem.ExternalKey, runtimeItem.AgentKey).String(),
		"agentPermission":        agentValue.Permission,
		"flagship":               runtimeItem.Flagship,
		"artifactSource":         runtimeItem.ArtifactSource,
		"outcome":                runtimeItem.Outcome,
		"occurredAt":             manifestItem.OccurredAt,
		"reactionHistory":        reactionMetadata,
		"chatLineCount":          len(runtimeItem.Chat),
		"pendingArtifactCapture": runtimeItem.Flagship,
		"pendingArtifactCount":   boolInt(runtimeItem.Flagship, 3),
		"availableArtifactRefs":  artifactMetadata,
		"nativeWhiteboard":       true,
		"nativeParticipantCount": len(runtimeItem.ParticipantKeys) + 1,
	})
}

func buildArtifactMetadata(value dataset, ids datasetIDs, item episode) map[string]any {
	artifactValue, ok := value.ArtifactByEpKey[item.ExternalKey]
	if !ok {
		return map[string]any{}
	}
	refs := make(map[string]any)
	for name, key := range map[string]string{
		"transcript": artifactValue.TranscriptKey,
		"whiteboard": artifactValue.WhiteboardKey,
		"recording":  artifactValue.RecordingKey,
	} {
		assetValue, exists := value.AssetByKey[key]
		if !exists || assetValue.Status != "built" {
			continue
		}
		storageKey := assetValue.StorageKey
		if name == "recording" {
			storageKey = nativeRecordingStorageKey(value, ids, assetValue)
		}
		refs[name] = map[string]any{
			"assetKey":   assetValue.AssetKey,
			"storageKey": storageKey,
			"mimeType":   assetValue.MimeType,
			"title":      assetValue.Title,
			"native":     true,
		}
	}
	return refs
}

func buildReactionMetadata(value dataset, ids datasetIDs, item episode) []map[string]any {
	result := make([]map[string]any, 0, len(item.Reactions))
	for index, reaction := range item.Reactions {
		userValue := value.UserByKey[reaction.UserKey]
		result = append(result, map[string]any{
			"kind":          reaction.Kind,
			"userKey":       reaction.UserKey,
			"participantId": participantID(ids, item.ExternalKey, reaction.UserKey).String(),
			"displayName":   userValue.DisplayNameEN,
			"occurredAt":    item.OccurredAt.Add(time.Duration(index+1) * time.Minute),
			"native":        true,
		})
	}
	return result
}

func boolInt(value bool, trueValue int) int {
	if value {
		return trueValue
	}
	return 0
}

func seedEpisodeControl(ctx context.Context, tx pgx.Tx, value dataset, ids datasetIDs, seed episodeSeed) error {
	joined := make([]snapshotParticipant, 0, len(seed.Participants))
	for index, participant := range seed.Participants {
		joined = append(joined, snapshotParticipant{
			ParticipantID:     participant.ParticipantID.String(),
			DisplayName:       participant.DisplayName,
			Role:              participant.Role,
			AdmissionRevision: index + 1,
		})
	}
	finalSnapshot, finalWire, finalDigest, err := snapshotForEpisode(value, ids, seed.Item, nil, "ended", len(joined)+1)
	if err != nil {
		return fmt.Errorf("build Episode control snapshot %s: %w", seed.Item.ExternalKey, err)
	}
	finalEncoded, err := json.Marshal(finalSnapshot)
	if err != nil {
		return fmt.Errorf("encode final Episode control state %s: %w", seed.Item.ExternalKey, err)
	}
	endIndex := len(joined) + 1
	if _, err := tx.Exec(ctx, `
		insert into sync_episode_control (
			tenant_id, space_id, episode_id, control_revision, folded_state,
			state_schema_version, state_digest, snapshot_bytes,
			participant_event_count, participant_event_bytes,
			lifecycle_event_count, lifecycle_event_bytes,
			lifecycle_reserved_events, lifecycle_reserved_bytes,
			lifecycle_intent_count, lifecycle_intent_bytes,
			lifecycle_reserved_intents, lifecycle_reserved_intent_bytes
		)
		values ($1, $2, $3, $4, $5::jsonb, 1, $6, $7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
	`, seed.TenantID, seed.SpaceID, seed.EpisodeID, endIndex, finalEncoded, finalDigest[:], len(finalWire)); err != nil {
		return fmt.Errorf("insert Episode control state %s: %w", seed.Item.ExternalKey, err)
	}
	intentBytes := 0
	eventBytes := 0
	for index, participant := range joined {
		payload := map[string]any{
			"participant_id":     participant.ParticipantID,
			"display_name":       participant.DisplayName,
			"role":               participant.Role,
			"admission_revision": participant.AdmissionRevision,
		}
		encodedPayload, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			return fmt.Errorf("encode join event %s: %w", seed.Item.ExternalKey, marshalErr)
		}
		payloadSize := len(encodedPayload)
		intentBytes += payloadSize
		// The reducer sorts participant entries by id when calculating each digest.
		_, _, digest, snapshotErr := snapshotForEpisode(value, ids, seed.Item, append([]snapshotParticipant{}, joined[:index+1]...), "active", index+1)
		if snapshotErr != nil {
			return fmt.Errorf("build join digest %s: %w", seed.Item.ExternalKey, snapshotErr)
		}
		intentID := deterministicID("lifecycle-intent", seed.Item.ExternalKey+"/join/"+strconv.Itoa(index+1))
		eventID := deterministicID("control-event", seed.Item.ExternalKey+"/join/"+strconv.Itoa(index+1))
		requestKey := "showcase-join-" + seed.Item.ExternalKey + "-" + strconv.Itoa(index+1)
		fingerprint := sha256.Sum256(encodedPayload)
		if _, err := tx.Exec(ctx, `
			insert into sync_lifecycle_intents (
				tenant_id, space_id, episode_id, lifecycle_intent_id,
				request_key, request_fingerprint, intent_name, participant_id,
				participant_generation, payload, status
			)
			values ($1, $2, $3, $4, $5, $6, 'participant_joined', $7, 1, $8::jsonb, 'pending')
		`, seed.TenantID, seed.SpaceID, seed.EpisodeID, intentID, requestKey, fingerprint[:], participant.ParticipantID, encodedPayload); err != nil {
			return fmt.Errorf("insert participant join intent %s: %w", seed.Item.ExternalKey, err)
		}
		eventSize, err := lifecycleEventBytes(
			"participant_joined",
			index,
			index+1,
			payload,
			eventID,
			intentID,
			digest,
		)
		if err != nil {
			return fmt.Errorf("encode participant join event %s: %w", seed.Item.ExternalKey, err)
		}
		eventBytes += eventSize
		if _, err := tx.Exec(ctx, `
			insert into sync_control_events (
				tenant_id, space_id, episode_id, event_id, base_revision,
				revision, event_name, payload, lifecycle_intent_id,
				event_schema_version, resulting_state_digest, encoded_bytes
			)
			values ($1, $2, $3, $4, $5, $6, 'participant_joined', $7::jsonb, $8, 1, $9, $10)
		`, seed.TenantID, seed.SpaceID, seed.EpisodeID, eventID, index, index+1, encodedPayload, intentID, digest[:], eventSize); err != nil {
			return fmt.Errorf("insert participant join event %s: %w", seed.Item.ExternalKey, err)
		}
		if _, err := tx.Exec(ctx, `
			update sync_lifecycle_intents
			set status = 'applied', applied_event_id = $1, applied_revision = $2, completed_at = $3
			where lifecycle_intent_id = $4
		`, eventID, index+1, seed.Item.OccurredAt.Add(time.Duration(index+1)*time.Second), intentID); err != nil {
			return fmt.Errorf("apply participant join intent %s: %w", seed.Item.ExternalKey, err)
		}
	}
	endPayload := map[string]any{"reason": "ended_by_participant"}
	encodedEnd, err := json.Marshal(endPayload)
	if err != nil {
		return fmt.Errorf("encode Episode end event %s: %w", seed.Item.ExternalKey, err)
	}
	endIntentID := deterministicID("lifecycle-intent", seed.Item.ExternalKey+"/end")
	endEventID := deterministicID("control-event", seed.Item.ExternalKey+"/end")
	endFingerprint := sha256.Sum256(encodedEnd)
	endRequestKey := "showcase-end-" + seed.Item.ExternalKey
	if _, err := tx.Exec(ctx, `
		insert into sync_lifecycle_intents (
			tenant_id, space_id, episode_id, lifecycle_intent_id,
			request_key, request_fingerprint, intent_name, payload, status
		)
		values ($1, $2, $3, $4, $5, $6, 'episode_ended', $7::jsonb, 'pending')
	`, seed.TenantID, seed.SpaceID, seed.EpisodeID, endIntentID, endRequestKey, endFingerprint[:], encodedEnd); err != nil {
		return fmt.Errorf("insert Episode end intent %s: %w", seed.Item.ExternalKey, err)
	}
	endSize, err := lifecycleEventBytes(
		"episode_ended",
		endIndex-1,
		endIndex,
		endPayload,
		endEventID,
		endIntentID,
		finalDigest,
	)
	if err != nil {
		return fmt.Errorf("encode Episode end event %s: %w", seed.Item.ExternalKey, err)
	}
	eventBytes += endSize
	intentBytes += len(encodedEnd)
	if _, err := tx.Exec(ctx, `
		insert into sync_control_events (
			tenant_id, space_id, episode_id, event_id, base_revision,
			revision, event_name, payload, lifecycle_intent_id,
			event_schema_version, resulting_state_digest, encoded_bytes
		)
		values ($1, $2, $3, $4, $5, $6, 'episode_ended', $7::jsonb, $8, 1, $9, $10)
	`, seed.TenantID, seed.SpaceID, seed.EpisodeID, endEventID, endIndex-1, endIndex, encodedEnd, endIntentID, finalDigest[:], endSize); err != nil {
		return fmt.Errorf("insert Episode end event %s: %w", seed.Item.ExternalKey, err)
	}
	if _, err := tx.Exec(ctx, `
		update sync_lifecycle_intents
		set status = 'applied', applied_event_id = $1, applied_revision = $2, completed_at = $3
		where lifecycle_intent_id = $4
	`, endEventID, endIndex, seed.Item.OccurredAt.Add(45*time.Minute), endIntentID); err != nil {
		return fmt.Errorf("apply Episode end intent %s: %w", seed.Item.ExternalKey, err)
	}
	if _, err := tx.Exec(ctx, `
		update sync_episode_control
		set participant_event_count = $1,
			participant_event_bytes = $2,
			lifecycle_event_count = $3,
			lifecycle_event_bytes = $4,
			lifecycle_intent_count = $3,
			lifecycle_intent_bytes = $5,
			updated_at = now()
		where tenant_id = $6 and episode_id = $7
	`, 0, 0, endIndex, eventBytes, intentBytes, seed.TenantID, seed.EpisodeID); err != nil {
		return fmt.Errorf("update Episode control counters %s: %w", seed.Item.ExternalKey, err)
	}
	return nil
}

func lifecycleEventBytes(name string, baseRevision, revision int, payload map[string]any, eventID, intentID uuid.UUID, digest [32]byte) (int, error) {
	encoded, err := json.Marshal(map[string]any{
		"name":                   name,
		"base_revision":          baseRevision,
		"revision":               revision,
		"payload":                payload,
		"event_id":               eventID.String(),
		"command_id":             nil,
		"lifecycle_intent_id":    intentID.String(),
		"schema_version":         1,
		"resulting_state_digest": hex.EncodeToString(digest[:]),
	})
	if err != nil {
		return 0, err
	}
	return len(encoded), nil
}

func seedWhiteboard(ctx context.Context, tx pgx.Tx, seed episodeSeed) error {
	color := whiteboardColor(seed.Item.ExternalKey)
	elements := []struct {
		typ     string
		payload map[string]any
	}{
		{typ: "text", payload: map[string]any{"text": seed.Item.Title, "x": 80, "y": 60, "fontSize": 24}},
		{typ: "rectangle", payload: map[string]any{"x": 80, "y": 140, "width": 300, "height": 120, "label": "Evidence", "color": color}},
		{typ: "arrow", payload: map[string]any{"x": 380, "y": 200, "width": 160, "height": 0, "label": "Decision"}},
		{typ: "ellipse", payload: map[string]any{"x": 540, "y": 140, "width": 240, "height": 120, "label": seed.Item.Outcome}},
		{typ: "sticky", payload: map[string]any{"x": 80, "y": 320, "width": 300, "height": 100, "text": "Owner named in Episode chat", "color": color}},
		{typ: "text", payload: map[string]any{"text": "Next step: carry the decision into the next review.", "x": 80, "y": 480, "fontSize": 16}},
	}
	sceneID := deterministicID("scene", seed.Item.ExternalKey)
	totalBytes := 0
	encodedPayloads := make([][]byte, len(elements))
	for index, element := range elements {
		encoded, err := json.Marshal(element.payload)
		if err != nil {
			return fmt.Errorf("encode whiteboard element %s: %w", seed.Item.ExternalKey, err)
		}
		encodedPayloads[index] = encoded
		totalBytes += len(encoded) + 16
	}
	appState, err := json.Marshal(map[string]string{"view_background_color": color})
	if err != nil {
		return fmt.Errorf("encode whiteboard app state %s: %w", seed.Item.ExternalKey, err)
	}
	if _, err := tx.Exec(ctx, `
		insert into sync_whiteboard_scenes (
			tenant_id, space_id, episode_id, scene_id, is_current,
			revision, app_state, element_count, encoded_bytes
		)
		values ($1, $2, $3, $4, true, 1, $5::jsonb, $6, $7)
	`, seed.TenantID, seed.SpaceID, seed.EpisodeID, sceneID, appState, len(elements), totalBytes); err != nil {
		return fmt.Errorf("insert whiteboard scene %s: %w", seed.Item.ExternalKey, err)
	}
	for index, element := range elements {
		elementID := deterministicID("whiteboard-element", seed.Item.ExternalKey+"/"+strconv.Itoa(index))
		if _, err := tx.Exec(ctx, `
			insert into sync_whiteboard_elements (
				tenant_id, space_id, episode_id, scene_id, element_id,
				element_type, version, version_nonce, element_index,
				is_deleted, payload, encoded_bytes
			)
			values ($1, $2, $3, $4, $5, $6, 1, 0, $7, false, $8::jsonb, $9)
		`, seed.TenantID, seed.SpaceID, seed.EpisodeID, sceneID, elementID.String(), element.typ,
			fmt.Sprintf("%03d", index), encodedPayloads[index], len(encodedPayloads[index])+16); err != nil {
			return fmt.Errorf("insert whiteboard element %s: %w", seed.Item.ExternalKey, err)
		}
	}
	grantor := seed.Participants[0].ParticipantID
	for _, participant := range seed.Participants {
		canDraw := contains(participant.Capabilities, "drawWhiteboard")
		if _, err := tx.Exec(ctx, `
			insert into sync_whiteboard_permissions (
				tenant_id, space_id, episode_id, participant_id,
				can_draw, granted_by_participant_id
			)
			values ($1, $2, $3, $4, $5, $6)
		`, seed.TenantID, seed.SpaceID, seed.EpisodeID, participant.ParticipantID, canDraw, grantor); err != nil {
			return fmt.Errorf("insert whiteboard permission %s: %w", seed.Item.ExternalKey, err)
		}
	}
	return nil
}

func seedChats(ctx context.Context, tx pgx.Tx, value dataset, ids datasetIDs, seeds []episodeSeed) error {
	bySpace := make(map[string][]chatSeed)
	for _, seed := range seeds {
		for index, line := range seed.Item.Chat {
			participant := participantID(ids, seed.Item.ExternalKey, line.AuthorKey)
			displayName := value.UserByKey[line.AuthorKey].DisplayNameEN
			bySpace[seed.Item.SpaceKey] = append(bySpace[seed.Item.SpaceKey], chatSeed{
				Seed:          seed,
				SequenceIndex: index,
				ParticipantID: participant,
				DisplayName:   displayName,
				Line:          line,
			})
		}
	}
	spaceKeys := make([]string, 0, len(bySpace))
	for key := range bySpace {
		spaceKeys = append(spaceKeys, key)
	}
	sort.Strings(spaceKeys)
	for _, spaceKey := range spaceKeys {
		messages := bySpace[spaceKey]
		spaceID := uuid.MustParse(ids.SpaceIDs[spaceKey])
		tenantID := uuid.MustParse(ids.TenantIDs[value.SpaceByKey[spaceKey].TenantKey])
		messageBytes := int64(0)
		for _, message := range messages {
			messageBytes += int64(len(message.Line.Text) + len(message.DisplayName) + 64)
		}
		if _, err := tx.Exec(ctx, `
			insert into sync_chat_streams (
				tenant_id, space_id, head_sequence, retained_floor_sequence,
				message_count, message_bytes
			)
			values ($1, $2, $3, 1, $3, $4)
		`, tenantID, spaceID, len(messages), messageBytes); err != nil {
			return fmt.Errorf("insert chat stream %s: %w", spaceKey, err)
		}
		for index, message := range messages {
			sequence := index + 1
			messageID := deterministicID("chat-message", message.Seed.Item.ExternalKey+"/"+strconv.Itoa(message.SequenceIndex))
			clientMessageID := "showcase-chat-" + shortHash(message.Seed.Item.ExternalKey+"/"+strconv.Itoa(message.SequenceIndex))
			fingerprint := sha256.Sum256([]byte(message.Line.Text))
			encodedBytes := len(message.Line.Text) + len(message.DisplayName) + 64
			if _, err := tx.Exec(ctx, `
				insert into sync_chat_messages (
					tenant_id, space_id, episode_id, sequence, message_id,
					participant_id, participant_generation, client_message_id,
					request_fingerprint, display_name, message_text, encoded_bytes,
					created_at
				)
				values ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12)
			`, tenantID, spaceID, message.Seed.EpisodeID, sequence, messageID,
				message.ParticipantID, clientMessageID, fingerprint[:], message.DisplayName,
				message.Line.Text, encodedBytes, message.Seed.Item.OccurredAt.Add(time.Duration(message.SequenceIndex+1)*time.Minute)); err != nil {
				return fmt.Errorf("insert chat message %s: %w", message.Seed.Item.ExternalKey, err)
			}
		}
	}
	return nil
}

type chatSeed struct {
	Seed          episodeSeed
	SequenceIndex int
	ParticipantID uuid.UUID
	DisplayName   string
	Line          chatLine
}

func seedArtifacts(ctx context.Context, tx pgx.Tx, value dataset, ids datasetIDs, seeds []episodeSeed) error {
	for _, seed := range seeds {
		artifactValue, ok := value.ArtifactByEpKey[seed.Item.ExternalKey]
		if !ok {
			continue
		}
		transcriptAsset, transcriptOK := value.AssetByKey[artifactValue.TranscriptKey]
		if !transcriptOK || transcriptAsset.Status != "built" {
			continue
		}
		recordingAsset, recordingOK := value.AssetByKey[artifactValue.RecordingKey]
		recordingID := uuid.MustParse(ids.RecordingIDs[seed.Item.ExternalKey])
		recordingMetadata, err := json.Marshal(map[string]any{
			"showcaseDatasetId": showcaseDatasetID,
			"datasetVersion":    showcaseDatasetVersion,
			"episodeKey":        seed.Item.ExternalKey,
			"assetKey":          map[bool]string{true: recordingAsset.AssetKey, false: ""}[recordingOK && recordingAsset.Status == "built"],
			"available":         recordingOK && recordingAsset.Status == "built",
			"syntheticFixture":  recordingOK && recordingAsset.Status == "built",
			"reason":            map[bool]string{true: "", false: "recording-capture-not-in-pack"}[recordingOK && recordingAsset.Status == "built"],
		})
		if err != nil {
			return fmt.Errorf("encode recording metadata %s: %w", seed.Item.ExternalKey, err)
		}
		var recordingStorageKey any
		recordingStatus := "failed"
		if recordingOK && recordingAsset.Status == "built" {
			recordingStatus = "completed"
			recordingStorageKey = nativeRecordingStorageKey(value, ids, recordingAsset)
		}
		if _, err := tx.Exec(ctx, `
			insert into recordings (
				id, tenant_id, space_id, episode_id, status,
				storage_provider, storage_key, metadata
			)
			values ($1, $2, $3, $4, $5, 'r2', $6, $7::jsonb)
		`, recordingID, seed.TenantID, seed.SpaceID, seed.EpisodeID, recordingStatus, recordingStorageKey, recordingMetadata); err != nil {
			return fmt.Errorf("insert recording %s: %w", seed.Item.ExternalKey, err)
		}
		transcriptHash, err := parseContentHash(transcriptAsset.ContentHash)
		if err != nil {
			return fmt.Errorf("parse transcript hash %s: %w", seed.Item.ExternalKey, err)
		}
		transcriptMetadata, err := json.Marshal(map[string]any{
			"showcaseDatasetId": showcaseDatasetID,
			"datasetVersion":    showcaseDatasetVersion,
			"assetKey":          transcriptAsset.AssetKey,
			"title":             transcriptAsset.Title,
			"source":            transcriptAsset.Source,
		})
		if err != nil {
			return fmt.Errorf("encode transcription metadata %s: %w", seed.Item.ExternalKey, err)
		}
		if _, err := tx.Exec(ctx, `
			insert into transcriptions (
				id, tenant_id, recording_id, space_id, episode_id,
				status, provider, model, languages, metadata,
				artifact_key, artifact_sha256, artifact_size, artifact_content_type,
				source_manifest_key, source_manifest_sha256, source_manifest_size,
				source_manifest_content_type, generation, completed_at
			)
			values ($1, $2, $3, $4, $5, 'complete', 'showcase-fixture',
				'offline-template', $6, $7::jsonb, $8, $9, $10, $11,
				'showcase-v1/chalk-assets.json', $12, $13, 'application/json', 1, $14)
		`, uuid.MustParse(ids.TranscriptIDs[seed.Item.ExternalKey]), seed.TenantID, recordingID,
			seed.SpaceID, seed.EpisodeID, localeLanguages(transcriptAsset.Locale), transcriptMetadata,
			transcriptAsset.StorageKey, transcriptHash[:], transcriptAsset.FileSize, transcriptAsset.MimeType,
			value.AssetsHash[:], len(value.AssetsRaw), seed.Item.OccurredAt.Add(45*time.Minute)); err != nil {
			return fmt.Errorf("insert transcription %s: %w", seed.Item.ExternalKey, err)
		}
	}
	return nil
}

func spaceSlug(externalKey string) string {
	return strings.TrimPrefix(externalKey, "chalk-space-")
}

func whiteboardColor(key string) string {
	colors := []string{"#FFF4D6", "#E4F1FF", "#E9F7E8", "#F7E6FF", "#FFE7E0", "#E5FAF3"}
	digest := sha256.Sum256([]byte(key))
	return colors[int(digest[0])%len(colors)]
}

func contains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func shortHash(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:12])
}

func parseContentHash(value string) ([32]byte, error) {
	var digest [32]byte
	if !strings.HasPrefix(value, "sha256:") {
		return digest, fmt.Errorf("expected sha256 prefix")
	}
	decoded, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	if err != nil || len(decoded) != len(digest) {
		return digest, fmt.Errorf("expected 32-byte SHA-256 digest")
	}
	copy(digest[:], decoded)
	return digest, nil
}

func localeLanguages(locale string) []string {
	parts := strings.Split(strings.ToLower(locale), "-")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			result = append(result, part)
		}
	}
	return result
}

func bytesEqual(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
