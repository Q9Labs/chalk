package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

type shortBackup struct {
	Path        string    `json:"path"`
	CipherSHA   string    `json:"cipher_sha256"`
	PlainSHA    string    `json:"plain_sha256"`
	RetainUntil time.Time `json:"retain_until"`
}

func shortBackupSink(directory string) (func(context.Context, tenantpurge.Plan) (shortBackup, error), error) {
	if !filepath.IsAbs(directory) {
		return nil, errors.New("absolute private backup directory required")
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return nil, err
	}
	if resolved != filepath.Clean(directory) {
		return nil, errors.New("backup directory must not traverse symlinks")
	}
	info, err := os.Stat(directory)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("backup directory must be owner-only")
	}
	for p := directory; ; p = filepath.Dir(p) {
		if _, err := os.Lstat(filepath.Join(p, ".git")); err == nil {
			return nil, errors.New("before-images must be outside Git")
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	key, err := base64.StdEncoding.DecodeString(os.Getenv("CHALK_TENANT_PURGE_BACKUP_KEY"))
	if err != nil || len(key) != 32 {
		return nil, errors.New("32-byte base64 backup key required in environment")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return func(ctx context.Context, plan tenantpurge.Plan) (shortBackup, error) {
		if err := ctx.Err(); err != nil {
			return shortBackup{}, err
		}
		raw, err := json.Marshal(plan)
		if err != nil {
			return shortBackup{}, err
		}
		nonce := make([]byte, gcm.NonceSize())
		if _, err := rand.Read(nonce); err != nil {
			return shortBackup{}, err
		}
		magic := []byte("CHALKTPB1")
		encrypted := append(append([]byte{}, magic...), nonce...)
		encrypted = gcm.Seal(encrypted, nonce, raw, magic)
		file, err := os.CreateTemp(directory, "before-image-*.json.enc")
		if err != nil {
			return shortBackup{}, err
		}
		path := file.Name()
		if _, err := file.Write(encrypted); err != nil {
			file.Close()
			return shortBackup{}, err
		}
		if err := file.Sync(); err != nil {
			file.Close()
			return shortBackup{}, err
		}
		if err := file.Close(); err != nil {
			return shortBackup{}, err
		}
		if err := syncDirectory(directory); err != nil {
			return shortBackup{}, err
		}
		plainSHA := sha256.Sum256(raw)
		cipherSHA := sha256.Sum256(encrypted)
		receipt := shortBackup{path, hex.EncodeToString(cipherSHA[:]), hex.EncodeToString(plainSHA[:]), time.Now().UTC().Add(14 * 24 * time.Hour)}
		receiptFile, err := os.OpenFile(path+".receipt.private.json", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return receipt, err
		}
		if err := json.NewEncoder(receiptFile).Encode(receipt); err != nil {
			receiptFile.Close()
			return receipt, err
		}
		if err := receiptFile.Sync(); err != nil {
			receiptFile.Close()
			return receipt, err
		}
		if err := receiptFile.Close(); err != nil {
			return receipt, err
		}
		if err := syncDirectory(directory); err != nil {
			return receipt, err
		}
		return receipt, ctx.Err()
	}, nil
}

func syncDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func runShort(ctx context.Context, repository postgres.TenantPurgeRepository, o options) error {
	if !o.apply {
		if o.operation == "cleanup-short" {
			return errors.New("cleanup-short requires --apply")
		}
		var scope tenantpurge.Scope
		if err := readPrivate(o.scope, &scope); err != nil {
			return err
		}
		var plan tenantpurge.Plan
		var err error
		if o.operation == "backfill-short" {
			var b tenantpurge.Backfill
			if err := readPrivate(o.backfill, &b); err != nil {
				return err
			}
			plan, err = repository.SnapshotBackfillShort(ctx, scope, b, o.export)
		} else {
			plan, err = repository.SnapshotShort(ctx, scope, o.export)
			if err == nil && o.objects != "" {
				var m tenantpurge.ObjectManifest
				if err := readPrivate(o.objects, &m); err != nil {
					return err
				}
				if err := m.Validate(scope); err != nil {
					return err
				}
				plan.Objects = &m
			}
		}
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
		return cleanupShort(ctx, repository, plan, o)
	}
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
	if _, err := out.Seek(0, 0); err != nil {
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
	return summarize(applied)
}

func cleanupShort(ctx context.Context, repository postgres.TenantPurgeRepository, plan tenantpurge.Plan, o options) error {
	return cleanup(ctx, repository, plan, o)
}

// Carry only authenticated, durably receipted before-images. This works after
// a partial run or unknown commit outcome without another production write.
func carryShortBeforeImages(directory string, plan *tenantpurge.Plan) error {
	key, err := base64.StdEncoding.DecodeString(os.Getenv("CHALK_TENANT_PURGE_BACKUP_KEY"))
	if err != nil || len(key) != 32 {
		return errors.New("backup key required")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "before-image-") || !strings.HasSuffix(entry.Name(), ".json.enc") {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
			return errors.New("before-image must be private regular file")
		}
		if _, err := os.Lstat(path + ".receipt.private.json"); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return err
		}
		var receipt shortBackup
		if err := readPrivate(path+".receipt.private.json", &receipt); err != nil {
			return err
		}
		if receipt.Path != path {
			return errors.New("before-image receipt path differs")
		}
		encrypted, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		hash := sha256.Sum256(encrypted)
		if hex.EncodeToString(hash[:]) != receipt.CipherSHA {
			return errors.New("before-image ciphertext differs")
		}
		magic := []byte("CHALKTPB1")
		if len(encrypted) < len(magic)+gcm.NonceSize() || string(encrypted[:len(magic)]) != string(magic) {
			return errors.New("invalid before-image format")
		}
		raw, err := gcm.Open(nil, encrypted[len(magic):len(magic)+gcm.NonceSize()], encrypted[len(magic)+gcm.NonceSize():], magic)
		if err != nil {
			return err
		}
		plain := sha256.Sum256(raw)
		if hex.EncodeToString(plain[:]) != receipt.PlainSHA {
			return errors.New("before-image plaintext differs")
		}
		var before tenantpurge.Plan
		if err := json.Unmarshal(raw, &before); err != nil {
			return err
		}
		if before.Kind != "purge" {
			continue
		}
		if err := tenantpurge.CarryDeferredSeeds(plan, before); err != nil {
			return err
		}
	}
	return nil
}
