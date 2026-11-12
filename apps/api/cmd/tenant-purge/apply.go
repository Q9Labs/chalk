package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

// applyApproved runs an approved plan, or its object cleanup, once its backup receipt verifies.
func applyApproved(ctx context.Context, repository postgres.TenantPurgeRepository, o options) error {
	if o.plan == "" || o.backup == "" {
		return errors.New("plan and backup receipt required")
	}
	var plan tenantpurge.Plan
	var receipt tenantpurge.BackupReceipt
	if err := readPrivate(o.plan, &plan); err != nil {
		return err
	}
	if err := readPrivate(o.backup, &receipt); err != nil {
		return err
	}
	if err := verifyBackup(plan, receipt); err != nil {
		return err
	}
	if o.operation == "cleanup" {
		return cleanup(ctx, repository, plan, o)
	}
	return applyWithReceipt(ctx, repository, o, plan, receipt)
}

// applyWithReceipt creates the result file before the write transaction, so an
// interrupted run leaves a marker, then replaces the marker with the committed plan.
func applyWithReceipt(ctx context.Context, repository postgres.TenantPurgeRepository, o options, plan tenantpurge.Plan, receipt tenantpurge.BackupReceipt) error {
	if o.result == "" {
		return errors.New("result-out is required before a write transaction")
	}
	out, err := os.OpenFile(o.result, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := out.WriteString("{\"state\":\"started; inspect database if interrupted\"}\n"); err != nil {
		return err
	}
	if err := out.Sync(); err != nil {
		return err
	}
	applied, err := applyPlan(ctx, repository, o, plan, receipt)
	if err != nil {
		return err
	}
	if err := commitReceipt(out, applied); err != nil {
		return err
	}
	return summarize(applied)
}

func applyPlan(ctx context.Context, repository postgres.TenantPurgeRepository, o options, plan tenantpurge.Plan, receipt tenantpurge.BackupReceipt) (tenantpurge.Plan, error) {
	switch {
	case o.operation == "backfill":
		return repository.ApplyBackfill(ctx, plan, receipt)
	case o.backupRefresh != "":
		refresh, err := frozenBackupCommand(o.backupRefresh)
		if err != nil {
			return tenantpurge.Plan{}, err
		}
		return repository.ApplyWithFrozenBackup(ctx, plan, receipt, refresh)
	default:
		return repository.Apply(ctx, plan, receipt)
	}
}

func commitReceipt(out *os.File, applied tenantpurge.Plan) error {
	if _, err := out.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("transaction committed but receipt seek failed: %w", err)
	}
	if err := out.Truncate(0); err != nil {
		return fmt.Errorf("transaction committed but receipt truncate failed: %w", err)
	}
	if err := json.NewEncoder(out).Encode(struct {
		State string           `json:"state"`
		Plan  tenantpurge.Plan `json:"plan"`
	}{"committed", applied.WithoutValues()}); err != nil {
		return fmt.Errorf("transaction committed but receipt failed: %w", err)
	}
	if err := out.Sync(); err != nil {
		return fmt.Errorf("transaction committed but receipt sync failed: %w", err)
	}
	return nil
}

func cleanup(ctx context.Context, repository postgres.TenantPurgeRepository, plan tenantpurge.Plan, o options) error {
	if plan.Objects == nil {
		return errors.New("approved plan has no object manifest")
	}
	if o.operation != "cleanup-short" {
		if err := repository.VerifyObjectCleanup(ctx, plan); err != nil {
			return err
		}
	}
	if !o.apply {
		return json.NewEncoder(os.Stdout).Encode(struct {
			Objects int `json:"objects"`
		}{len(plan.Objects.Objects)})
	}
	if o.journal == "" {
		return errors.New("private cleanup journal required")
	}
	if os.Getenv("CHALK_R2_BUCKET") != plan.Objects.Bucket {
		return errors.New("runtime bucket differs from approved manifest")
	}
	store, err := r2.NewStore(config.R2Config{AccountID: os.Getenv("CHALK_R2_ACCOUNT_ID"), AccessKeyID: os.Getenv("CHALK_R2_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("CHALK_R2_SECRET_ACCESS_KEY"), Bucket: plan.Objects.Bucket, Endpoint: os.Getenv("CHALK_R2_ENDPOINT"), RequestTimeout: 30 * time.Second})
	if err != nil {
		return err
	}
	journal, err := openCleanupJournal(o.journal)
	if err != nil {
		return err
	}
	defer journal.Close()
	cleanupOne := func(ctx context.Context, manifest tenantpurge.ObjectManifest) error {
		return tenantpurge.CleanupObjects(ctx, store, manifest, func(object tenantpurge.StorageObject) error {
			if err := json.NewEncoder(journal).Encode(object); err != nil {
				return err
			}
			return journal.Sync()
		})
	}
	if o.operation == "cleanup-short" {
		err = repository.CleanupObjectsShort(ctx, plan, cleanupOne)
	} else {
		err = repository.CleanupObjects(ctx, plan, func() error { return cleanupOne(ctx, *plan.Objects) })
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		DeletedOrAbsent int `json:"deleted_or_absent"`
	}{len(plan.Objects.Objects)})
}

// openCleanupJournal opens the append-only journal, which must be a private regular file when it exists.
func openCleanupJournal(path string) (*os.File, error) {
	info, err := os.Lstat(path)
	switch {
	case err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0):
		return nil, errors.New("cleanup journal must be a private regular file")
	case err != nil && !errors.Is(err, os.ErrNotExist):
		return nil, err
	}
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
}
