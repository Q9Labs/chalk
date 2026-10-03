// tenant-purge is an operator-only command. Its default is read-only inventory.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

type options struct {
	operation, scope, plan, planOut, backfill, objects, backup, result, journal, backupRefresh string
	apply, dryRun, export                                                                      bool
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "tenant-purge:", err)
		os.Exit(1)
	}
}

func run() error {
	var o options
	flag.StringVar(&o.operation, "operation", "purge", "purge, backfill, or cleanup")
	flag.StringVar(&o.scope, "scope", "", "private exact identity partition JSON")
	flag.StringVar(&o.plan, "plan", "", "private previously inventoried plan")
	flag.StringVar(&o.planOut, "plan-out", "", "create a private keys/counts plan")
	flag.StringVar(&o.backfill, "backfill", "", "explicit Space candidates and service exclusions JSON")
	flag.StringVar(&o.objects, "objects", "", "explicit backed-up storage object manifest JSON")
	flag.StringVar(&o.backup, "backup-receipt", "", "restore-verified encrypted backup receipt")
	flag.StringVar(&o.backupRefresh, "backup-refresh-command", "", "private executable: frozen before-images on stdin, verified backup receipt on stdout")
	flag.StringVar(&o.result, "result-out", "", "create private relational commit receipt")
	flag.StringVar(&o.journal, "journal", "", "private append-only object cleanup journal")
	flag.BoolVar(&o.apply, "apply", false, "apply only an approved plan with verified backup")
	flag.BoolVar(&o.dryRun, "dry-run", false, "read-only (also the default)")
	flag.BoolVar(&o.export, "export", false, "stream affected before-images for encrypted backup; NEVER log this stream")
	flag.Parse()
	if flag.NArg() != 0 || o.apply && (o.dryRun || o.export) || o.backupRefresh != "" && (!o.apply || o.operation != "purge") {
		return errors.New("invalid argument combination")
	}
	if o.operation != "purge" && o.operation != "backfill" && o.operation != "cleanup" {
		return errors.New("unknown operation")
	}
	if o.export && o.planOut == "" {
		return errors.New("backup export requires a matching plan-out")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	url := os.Getenv("CHALK_DATABASE_URL")
	if url == "" {
		return errors.New("CHALK_DATABASE_URL required")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	repository := postgres.NewTenantPurgeRepository(pool)
	if o.apply || o.operation == "cleanup" {
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
		var applied tenantpurge.Plan
		if o.operation == "backfill" {
			applied, err = repository.ApplyBackfill(ctx, plan, receipt)
		} else if o.backupRefresh != "" {
			refresh, refreshErr := frozenBackupCommand(o.backupRefresh)
			if refreshErr != nil {
				return refreshErr
			}
			applied, err = repository.ApplyWithFrozenBackup(ctx, plan, receipt, refresh)
		} else {
			applied, err = repository.Apply(ctx, plan, receipt)
		}
		if err != nil {
			return err
		}
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
		return summarize(applied)
	}
	if o.scope == "" {
		return errors.New("scope required for dry-run inventory")
	}
	var scope tenantpurge.Scope
	if err := readPrivate(o.scope, &scope); err != nil {
		return err
	}
	var plan tenantpurge.Plan
	if o.operation == "backfill" {
		var b tenantpurge.Backfill
		if o.backfill == "" {
			return errors.New("explicit backfill file required")
		}
		if err := readPrivate(o.backfill, &b); err != nil {
			return err
		}
		plan, err = repository.SnapshotBackfill(ctx, scope, b, o.export)
	} else {
		plan, err = repository.Snapshot(ctx, scope, o.export)
	}
	if err != nil {
		return err
	}
	if o.objects != "" {
		var manifest tenantpurge.ObjectManifest
		if err := readPrivate(o.objects, &manifest); err != nil {
			return err
		}
		if err := manifest.Validate(scope); err != nil {
			return err
		}
		plan.Objects = &manifest
		if o.operation != "purge" {
			return errors.New("object manifests belong to purge plans only")
		}
		if err := repository.VerifyPurgeObjects(ctx, plan); err != nil {
			return err
		}
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

func readPrivate[T interface{}](path string, target *T) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return errors.New("input must be a private regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("input has trailing data")
	}
	return nil
}

func writePrivate(path string, value tenantpurge.Plan) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := json.NewEncoder(file).Encode(value); err != nil {
		return err
	}
	return file.Sync()
}

func verifyBackup(plan tenantpurge.Plan, receipt tenantpurge.BackupReceipt) error {
	if err := receipt.Validate(plan, time.Now().UTC()); err != nil {
		return err
	}
	info, err := os.Lstat(receipt.ArchivePath)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return errors.New("backup must be a private regular encrypted archive")
	}
	file, err := os.Open(receipt.ArchivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != receipt.ArchiveDigest {
		return errors.New("encrypted backup digest differs")
	}
	return nil
}

func summarize(plan tenantpurge.Plan) error {
	type count struct {
		Name string `json:"table"`
		Rows int64  `json:"rows"`
	}
	var counts []count
	var total int64
	for _, table := range plan.Tables {
		counts = append(counts, count{table.Name, table.Count})
		total += table.Count
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Kind   string  `json:"kind"`
		Rows   int64   `json:"rows"`
		Tables []count `json:"tables"`
	}{plan.Kind, total, counts})
}

func cleanup(ctx context.Context, repository postgres.TenantPurgeRepository, plan tenantpurge.Plan, o options) error {
	if plan.Objects == nil {
		return errors.New("approved plan has no object manifest")
	}
	if err := repository.VerifyObjectCleanup(ctx, plan); err != nil {
		return err
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
	if info, err := os.Lstat(o.journal); err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0) {
		return errors.New("cleanup journal must be a private regular file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	journal, err := os.OpenFile(o.journal, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer journal.Close()
	err = repository.CleanupObjects(ctx, plan, func() error {
		return tenantpurge.CleanupObjects(ctx, store, *plan.Objects, func(object tenantpurge.StorageObject) error {
			if err := json.NewEncoder(journal).Encode(object); err != nil {
				return err
			}
			return journal.Sync()
		})
	})
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		DeletedOrAbsent int `json:"deleted_or_absent"`
	}{len(plan.Objects.Objects)})
}
