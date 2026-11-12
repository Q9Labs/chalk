package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

func runShort(ctx context.Context, repository postgres.TenantPurgeRepository, o options) error {
	if !o.apply {
		return inventoryShort(ctx, repository, o)
	}
	var plan, baseline tenantpurge.Plan
	var receipt tenantpurge.BackupReceipt
	if err := readPrivate(o.plan, &plan); err != nil {
		return err
	}
	if err := readPrivate(o.baseline, &baseline); err != nil {
		return err
	}
	if err := readPrivate(o.backup, &receipt); err != nil {
		return err
	}
	// Baseline pg_dump/object bytes were restore-verified outside the fence.
	// Schema/values may legitimately differ; the live encrypted before-image is
	// authoritative. Approved identity partition and backed objects may not.
	if err := verifyBackup(baseline, receipt); err != nil {
		return err
	}
	if !reflect.DeepEqual(plan.Scope, baseline.Scope) || !reflect.DeepEqual(plan.Objects, baseline.Objects) {
		return errors.New("baseline identity or backed object scope differs")
	}
	if o.operation == "cleanup-short" {
		return cleanup(ctx, repository, plan, o)
	}
	return applyShort(ctx, repository, o, plan)
}

// inventoryShort reads the database for a scope and prints, saves or exports the plan. It writes nothing to the database.
func inventoryShort(ctx context.Context, repository postgres.TenantPurgeRepository, o options) error {
	if o.operation == "cleanup-short" {
		return errors.New("cleanup-short requires --apply")
	}
	var scope tenantpurge.Scope
	if err := readPrivate(o.scope, &scope); err != nil {
		return err
	}
	plan, err := snapshotShort(ctx, repository, scope, o)
	if err != nil {
		return err
	}
	if o.planOut != "" {
		if err := writePrivate(o.planOut, plan.WithoutValues()); err != nil {
			return err
		}
	}
	if o.export {
		return json.NewEncoder(os.Stdout).Encode(plan)
	}
	return summarize(plan)
}

func snapshotShort(ctx context.Context, repository postgres.TenantPurgeRepository, scope tenantpurge.Scope, o options) (tenantpurge.Plan, error) {
	if o.operation == "backfill-short" {
		var backfill tenantpurge.Backfill
		if err := readPrivate(o.backfill, &backfill); err != nil {
			return tenantpurge.Plan{}, err
		}
		return repository.SnapshotBackfillShort(ctx, scope, backfill, o.export)
	}
	plan, err := repository.SnapshotShort(ctx, scope, o.export)
	if err != nil || o.objects == "" {
		return plan, err
	}
	var manifest tenantpurge.ObjectManifest
	if err := readPrivate(o.objects, &manifest); err != nil {
		return tenantpurge.Plan{}, err
	}
	if err := manifest.Validate(scope); err != nil {
		return tenantpurge.Plan{}, err
	}
	plan.Objects = &manifest
	return plan, nil
}

// applyShort writes the plan inside the fence. It saves an encrypted before-image
// first, and leaves a started marker in the result file until the commit.
func applyShort(ctx context.Context, repository postgres.TenantPurgeRepository, o options, plan tenantpurge.Plan) error {
	sink, err := shortBackupSink(o.beforeImages)
	if err != nil {
		return err
	}
	if o.operation == "purge-short" {
		plan.DeferredSeeds = nil
		if err := carryShortBeforeImages(o.beforeImages, &plan); err != nil {
			return err
		}
	}
	if o.result == "" {
		return errors.New("exclusive result-out required")
	}
	out, err := os.OpenFile(o.result, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := out.WriteString("{\"state\":\"started; inspect before-images and database if interrupted\"}\n"); err != nil {
		return err
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := syncDirectory(filepath.Dir(o.result)); err != nil {
		return err
	}
	var saved shortBackup
	backup := func(ctx context.Context, live tenantpurge.Plan) error {
		var err error
		saved, err = sink(ctx, live)
		return err
	}
	var applied tenantpurge.Plan
	if o.operation == "purge-short" {
		applied, err = repository.ApplyTenantShort(ctx, plan, o.target, backup)
	} else {
		applied, err = repository.ApplyBackfillShort(ctx, plan, backup)
	}
	if err != nil {
		return err
	}
	if err := commitShortReceipt(out, saved, applied); err != nil {
		return err
	}
	return summarize(applied)
}

func commitShortReceipt(out *os.File, saved shortBackup, applied tenantpurge.Plan) error {
	if _, err := out.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("committed; receipt seek: %w", err)
	}
	if err := out.Truncate(0); err != nil {
		return fmt.Errorf("committed; receipt truncate: %w", err)
	}
	if err := json.NewEncoder(out).Encode(struct {
		State  string           `json:"state"`
		Backup shortBackup      `json:"before_image"`
		Plan   tenantpurge.Plan `json:"plan"`
	}{"committed", saved, applied.WithoutValues()}); err != nil {
		return fmt.Errorf("committed; receipt write: %w", err)
	}
	if err := out.Sync(); err != nil {
		return fmt.Errorf("committed; receipt fsync: %w", err)
	}
	return nil
}
