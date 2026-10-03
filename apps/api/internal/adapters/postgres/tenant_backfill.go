package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

func backfillIDs(scope tenantpurge.Scope, b tenantpurge.Backfill) ([]string, []string) {
	var tenants, spaces []string
	for _, tenant := range scope.Keep {
		tenants = append(tenants, tenant.ID)
	}
	for _, space := range b.Spaces {
		spaces = append(spaces, space.ID)
	}
	return tenants, spaces
}

func snapshotBackfill(ctx context.Context, tx purgeQueryer, scope tenantpurge.Scope, b tenantpurge.Backfill, values bool) (tenantpurge.Plan, purgeCatalog, error) {
	plan := tenantpurge.Plan{Version: 1, Kind: "backfill", CreatedAt: time.Now().UTC(), Scope: scope, Backfill: &b}
	if err := b.Validate(scope); err != nil {
		return plan, purgeCatalog{}, err
	}
	if err := checkPurgeScope(ctx, tx, scope, false); err != nil {
		return plan, purgeCatalog{}, err
	}
	catalog, err := loadPurgeCatalog(ctx, tx)
	if err != nil {
		return plan, catalog, err
	}
	plan.SchemaDigest, err = catalog.digest()
	if err != nil {
		return plan, catalog, err
	}
	tenants, spaces := backfillIDs(scope, b)
	rows, err := tx.Query(ctx, `select id::text,tenant_id::text,recording_policy,transcription_policy from public.spaces where id=any($1::uuid[]) order by id`, spaces)
	if err != nil {
		return plan, catalog, err
	}
	found := 0
	for rows.Next() {
		var id, tenant, capture, transcript string
		if err := rows.Scan(&id, &tenant, &capture, &transcript); err != nil {
			rows.Close()
			return plan, catalog, err
		}
		found++
		if !slices.ContainsFunc(b.Spaces, func(s tenantpurge.Space) bool { return s.ID == id && s.TenantID == tenant }) || capture != "disabled" || transcript != "disabled" {
			rows.Close()
			return plan, catalog, errors.New("approved legacy Space identity or disabled pair changed")
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return plan, catalog, err
	}
	rows.Close()
	if found != len(spaces) {
		return plan, catalog, errors.New("approved backfill Space disappeared")
	}
	policy, ok := catalog.table("tenant_artifact_policies")
	if !ok {
		return plan, catalog, errors.New("policy table missing")
	}
	data, err := readPurgeTable(ctx, tx, policy, `tenant_id=any($1::uuid[]) and (transcription_ceiling='disabled' or transcription_default_mode='disabled')`, tenants, values)
	if err != nil {
		return plan, catalog, err
	}
	plan.Tables = append(plan.Tables, data)
	spaceTable, ok := catalog.table("spaces")
	if !ok {
		return plan, catalog, errors.New("space table missing")
	}
	data, err = readPurgeTable(ctx, tx, spaceTable, `id=any($1::uuid[])`, spaces, values)
	if err != nil {
		return plan, catalog, err
	}
	plan.Tables = append(plan.Tables, data)
	return plan, catalog, nil
}

func (r TenantPurgeRepository) SnapshotBackfill(ctx context.Context, scope tenantpurge.Scope, b tenantpurge.Backfill, values bool) (tenantpurge.Plan, error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `set local timezone='UTC';set local statement_timeout='120s'`); err != nil {
		return tenantpurge.Plan{}, err
	}
	plan, _, err := snapshotBackfill(ctx, tx, scope, b, values)
	if err != nil {
		return plan, err
	}
	return plan, tx.Commit(ctx)
}

func validateRaisedPolicies(ctx context.Context, tx pgx.Tx, tenants []string) error {
	rows, err := tx.Query(ctx, `select transcription_ceiling,transcription_default_mode,provider_policy_version,recording_retention_seconds,transcript_retention_seconds,source_window_seconds from public.tenant_artifact_policies where tenant_id=any($1::uuid[])`, tenants)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var ceiling, mode, version string
		var recordingRetention, transcriptRetention, window int64
		if err := rows.Scan(&ceiling, &mode, &version, &recordingRetention, &transcriptRetention, &window); err != nil {
			return err
		}
		policy := artifactpolicy.TenantPolicy{TranscriptionCeiling: artifactpolicy.TranscriptionMode(ceiling), TranscriptionDefault: artifactpolicy.TranscriptionMode(mode), ProviderPolicyVersion: version, RecordingRetention: time.Duration(recordingRetention) * time.Second, TranscriptRetention: time.Duration(transcriptRetention) * time.Second, TranscriptionSourceWindow: time.Duration(window) * time.Second}
		if err := policy.Validate(); err != nil {
			return fmt.Errorf("raised policy invalid: %w", err)
		}
	}
	return rows.Err()
}

func (r TenantPurgeRepository) ApplyBackfill(ctx context.Context, expected tenantpurge.Plan, receipt tenantpurge.BackupReceipt) (tenantpurge.Plan, error) {
	if expected.Kind != "backfill" || expected.Backfill == nil {
		return tenantpurge.Plan{}, errors.New("not a backfill plan")
	}
	if err := receipt.Validate(expected, time.Now().UTC()); err != nil {
		return tenantpurge.Plan{}, err
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	defer tx.Rollback(ctx)
	catalog, err := loadPurgeCatalog(ctx, tx)
	if err != nil {
		return tenantpurge.Plan{}, err
	}
	if err := lockPurgeTables(ctx, tx, catalog); err != nil {
		return tenantpurge.Plan{}, err
	}
	current, _, err := snapshotBackfill(ctx, tx, expected.Scope, *expected.Backfill, false)
	if err != nil {
		return current, err
	}
	if err := tenantpurge.SameRows(expected, current); err != nil {
		return current, err
	}
	tenants, spaces := backfillIDs(expected.Scope, *expected.Backfill)
	// Only these two row sets may change. All other public rows, including
	// service Spaces, frozen Episodes and deliberate settings, are guarded.
	protected := make(map[string]string)
	for _, table := range catalog.Tables {
		condition := "false"
		ids := tenants
		if table.Name == "tenant_artifact_policies" {
			condition = `tenant_id=any($1::uuid[]) and (transcription_ceiling='disabled' or transcription_default_mode='disabled')`
		}
		if table.Name == "spaces" {
			condition = `id=any($1::uuid[])`
			ids = spaces
		}
		guards, err := protectedPurgeDigests(ctx, tx, purgeCatalog{Tables: []purgeTable{table}}, map[string]string{table.Name: condition}, ids)
		if err != nil {
			return current, err
		}
		protected[table.Name] = guards[table.Name]
	}
	// Fix the seven (or fewer) affected policy PKs before their selector changes.
	policyIDs := make([]string, 0)
	for _, table := range current.Tables {
		if table.Name != "tenant_artifact_policies" {
			continue
		}
		for _, row := range table.Rows {
			var key struct {
				TenantID string `json:"tenant_id"`
			}
			if err := json.Unmarshal(row.Key, &key); err != nil {
				return current, err
			}
			policyIDs = append(policyIDs, key.TenantID)
		}
	}
	if _, err := tx.Exec(ctx, `update public.tenant_artifact_policies set transcription_ceiling=case when transcription_ceiling='disabled' then 'on_demand' else transcription_ceiling end,transcription_default_mode=case when transcription_default_mode='disabled' then 'on_demand' else transcription_default_mode end,provider_policy_version=case when btrim(provider_policy_version)='' then 'chalk-on-demand-v1' else provider_policy_version end,source_window_seconds=case when source_window_seconds=0 then 86400 else source_window_seconds end,updated_at=now() where tenant_id=any($1::uuid[])`, policyIDs); err != nil {
		return current, err
	}
	if _, err := tx.Exec(ctx, `update public.spaces set recording_policy='automatic',transcription_policy='on_demand',updated_at=now() where id=any($1::uuid[]) and recording_policy='disabled' and transcription_policy='disabled'`, spaces); err != nil {
		return current, err
	}
	if err := validateRaisedPolicies(ctx, tx, tenants); err != nil {
		return current, err
	}
	for _, table := range catalog.Tables {
		condition := "false"
		ids := tenants
		if table.Name == "tenant_artifact_policies" {
			condition = `tenant_id=any($1::uuid[])`
			ids = policyIDs
		}
		if table.Name == "spaces" {
			condition = `id=any($1::uuid[])`
			ids = spaces
		}
		guards, err := protectedPurgeDigests(ctx, tx, purgeCatalog{Tables: []purgeTable{table}}, map[string]string{table.Name: condition}, ids)
		if err != nil {
			return current, err
		}
		if guards[table.Name] != protected[table.Name] {
			return current, fmt.Errorf("backfill changed held rows in %s", table.Name)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return current, err
	}
	return current, nil
}
