package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type registryRecord struct {
	OrganizationID   uuid.UUID
	OwnerUserID      uuid.UUID
	State            string
	ManifestHash     []byte
	AssetsHash       []byte
	Counts           []byte
	PendingAssetKeys []byte
}

func openPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse Chalk database URL: %w", err)
	}
	config.MaxConns = 4
	config.MinConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open Chalk database: %w", err)
	}
	pingContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingContext); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping Chalk database: %w", err)
	}
	return pool, nil
}

func loadRegistry(ctx context.Context, pool *pgxpool.Pool, organizationKey string) (registryRecord, bool, error) {
	var value registryRecord
	err := pool.QueryRow(ctx, `
		select organization_id, owner_user_id, state, manifest_sha256, assets_sha256,
		       counts, pending_asset_keys
		from showcase_dataset_registries
		where dataset_id = $1 and product = $2 and organization_key = $3
	`, showcaseDatasetID, showcaseProduct, organizationKey).Scan(
		&value.OrganizationID,
		&value.OwnerUserID,
		&value.State,
		&value.ManifestHash,
		&value.AssetsHash,
		&value.Counts,
		&value.PendingAssetKeys,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return registryRecord{}, false, nil
	}
	if err != nil {
		return registryRecord{}, false, fmt.Errorf("load Chalk showcase registry: %w", err)
	}
	return value, true, nil
}

func insertRegistry(ctx context.Context, tx pgx.Tx, value dataset, ids datasetIDs, ownerID uuid.UUID) error {
	counts, err := json.Marshal(map[string]int{
		"organizations": len(value.Manifest.Records.Organizations),
		"tenants":       len(value.Manifest.Records.Tenants),
		"spaces":        len(value.Manifest.Records.Spaces),
		"users":         len(value.Manifest.Records.Users),
		"agents":        len(value.Manifest.Records.Agents),
		"episodes":      len(value.Manifest.Records.Episodes),
		"artifacts":     len(value.Manifest.Records.Artifacts),
		"assets":        len(value.Assets.Assets),
	})
	if err != nil {
		return fmt.Errorf("encode registry counts: %w", err)
	}
	pending, err := json.Marshal(pendingAssetKeys(value))
	if err != nil {
		return fmt.Errorf("encode pending asset slots: %w", err)
	}
	_, err = tx.Exec(ctx, `
		insert into showcase_dataset_registries (
			dataset_id, product, dataset_version, organization_key, organization_id,
			owner_user_id, state, manifest_sha256, assets_sha256, counts,
			pending_asset_keys
		) values ($1, $2, $3, $4, $5, $6, 'applying', $7, $8, $9::jsonb, $10::jsonb)
	`, showcaseDatasetID, showcaseProduct, value.Manifest.DatasetVersion, value.Manifest.Records.Organizations[0].ExternalKey,
		ids.OrganizationID, ownerID, value.ManifestHash[:], value.AssetsHash[:], counts, pending)
	if err != nil {
		return fmt.Errorf("reserve Chalk showcase registry: %w", err)
	}
	return nil
}

func registryMatchesDataset(value dataset, registry registryRecord) error {
	expectedCounts := map[string]int{
		"organizations": len(value.Manifest.Records.Organizations),
		"tenants":       len(value.Manifest.Records.Tenants),
		"spaces":        len(value.Manifest.Records.Spaces),
		"users":         len(value.Manifest.Records.Users),
		"agents":        len(value.Manifest.Records.Agents),
		"episodes":      len(value.Manifest.Records.Episodes),
		"artifacts":     len(value.Manifest.Records.Artifacts),
		"assets":        len(value.Assets.Assets),
	}
	actualCounts := make(map[string]int)
	if err := json.Unmarshal(registry.Counts, &actualCounts); err != nil {
		return fmt.Errorf("decode registry counts: %w", err)
	}
	if !maps.Equal(actualCounts, expectedCounts) {
		return errors.New("chalk showcase registry counts do not match the manifest")
	}
	expectedPending := pendingAssetKeys(value)
	actualPending := make([]string, 0)
	if err := json.Unmarshal(registry.PendingAssetKeys, &actualPending); err != nil {
		return fmt.Errorf("decode registry pending asset slots: %w", err)
	}
	if !slices.Equal(actualPending, expectedPending) {
		return errors.New("chalk showcase registry pending asset slots do not match the manifest")
	}
	return nil
}

func markRegistryApplied(ctx context.Context, tx pgx.Tx, organizationKey string) error {
	result, err := tx.Exec(ctx, `
		update showcase_dataset_registries
		set state = 'applied', updated_at = now()
		where dataset_id = $1 and product = $2 and organization_key = $3 and state = 'applying'
	`, showcaseDatasetID, showcaseProduct, organizationKey)
	if err != nil {
		return fmt.Errorf("mark Chalk showcase registry applied: %w", err)
	}
	if result.RowsAffected() != 1 {
		return errors.New("chalk showcase registry was not in applying state")
	}
	return nil
}

func ensureOwner(ctx context.Context, pool *pgxpool.Pool, ownerID uuid.UUID) error {
	var exists bool
	if err := pool.QueryRow(ctx, `select exists(select 1 from users where id = $1)`, ownerID).Scan(&exists); err != nil {
		return fmt.Errorf("check showcase owner account: %w", err)
	}
	if !exists {
		return fmt.Errorf("owner user %s does not exist", ownerID)
	}
	return nil
}

func ensureFreshIDs(ctx context.Context, pool *pgxpool.Pool, ids datasetIDs) error {
	checks := []struct {
		name  string
		query string
		ids   []uuid.UUID
	}{
		{name: "tenant", query: "select id from tenants where id = any($1::uuid[])", ids: stringIDs(ids.TenantIDs)},
		{name: "space", query: "select id from spaces where id = any($1::uuid[])", ids: stringIDs(ids.SpaceIDs)},
		{name: "user", query: "select id from users where id = any($1::uuid[])", ids: stringIDs(ids.UserIDs)},
		{name: "identity", query: "select id from identities where id = any($1::uuid[])", ids: stringIDs(ids.IdentityIDs)},
		{name: "episode", query: "select id from episodes where id = any($1::uuid[])", ids: stringIDs(ids.EpisodeIDs)},
		{name: "participant", query: "select id from participants where id = any($1::uuid[])", ids: stringIDs(ids.ParticipantIDs)},
		{name: "whiteboard scene", query: "select scene_id from sync_whiteboard_scenes where scene_id = any($1::uuid[])", ids: stringIDs(ids.SceneIDs)},
		{name: "recording", query: "select id from recordings where id = any($1::uuid[])", ids: stringIDs(ids.RecordingIDs)},
		{name: "transcription", query: "select id from transcriptions where id = any($1::uuid[])", ids: stringIDs(ids.TranscriptIDs)},
	}
	for _, check := range checks {
		if len(check.ids) == 0 {
			continue
		}
		rows, err := pool.Query(ctx, check.query, check.ids)
		if err != nil {
			return fmt.Errorf("check fresh %s ids: %w", check.name, err)
		}
		var existing uuid.UUID
		if rows.Next() {
			if err := rows.Scan(&existing); err != nil {
				rows.Close()
				return fmt.Errorf("read existing %s id: %w", check.name, err)
			}
			rows.Close()
			return fmt.Errorf("refusing to overwrite existing %s %s", check.name, existing)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("check fresh %s ids: %w", check.name, err)
		}
		rows.Close()
	}
	return nil
}

func stringIDs(values map[string]string) []uuid.UUID {
	result := make([]uuid.UUID, 0, len(values))
	for _, value := range values {
		result = append(result, uuid.MustParse(value))
	}
	return result
}
