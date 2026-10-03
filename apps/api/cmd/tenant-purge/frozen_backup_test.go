package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

func TestFrozenBackupExecutableRequiresMatchingArchiveAndHidesSQLCredentials(t *testing.T) {
	root := t.TempDir()
	command := filepath.Join(root, "backup")
	if err := os.WriteFile(command, []byte("#!/bin/sh\ntest -z \"$CHALK_DATABASE_URL\" || exit 7\ntest -z \"$PGPASSWORD\" || exit 8\ncat \"$0.receipt\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(root, "backup.enc")
	bytes := []byte("encrypted fixture")
	if err := os.WriteFile(archive, bytes, 0600); err != nil {
		t.Fatal(err)
	}
	plan := tenantpurge.Plan{Version: 1, Kind: "purge"}
	digest, err := plan.Digest()
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(bytes)
	now := time.Now().UTC()
	receipt := tenantpurge.BackupReceipt{PlanDigest: digest, ArchivePath: archive, ArchiveDigest: hex.EncodeToString(hash[:]), RestoreVerified: true, CompletedAt: now, RetainUntil: now.Add(14 * 24 * time.Hour)}
	writeReceipt := func() {
		data, err := json.Marshal(receipt)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(command+".receipt", data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeReceipt()
	t.Setenv("CHALK_DATABASE_URL", "must-not-reach-backup")
	t.Setenv("PGPASSWORD", "must-not-reach-backup")
	refresh, err := frozenBackupCommand(command)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := refresh(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	receipt.ArchiveDigest = tenantpurge.Digest([]byte("other bytes"))
	writeReceipt()
	if _, err := refresh(context.Background(), plan); err == nil {
		t.Fatal("wrong actual archive bytes accepted")
	}
	if err := os.Chmod(command, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := frozenBackupCommand(command); err == nil {
		t.Fatal("nonprivate executable accepted")
	}
}

func TestAllFilteredBackupEnvironmentNeverFallsBackToInheritance(t *testing.T) {
	child := backupChildEnvironment([]string{"CHALK_DATABASE_URL=must-not-inherit", "PGPASSWORD=must-not-inherit"})
	if child == nil || len(child) != 0 {
		t.Fatal("all-filtered environment must be non-nil and empty")
	}
}
