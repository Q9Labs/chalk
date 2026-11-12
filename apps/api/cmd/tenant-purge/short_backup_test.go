package main

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

func TestBeforeImageRoundTripsAndRejectsTampering(t *testing.T) {
	t.Setenv("CHALK_TENANT_PURGE_BACKUP_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	sink, err := shortBackupSink(directory)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := sink(context.Background(), tenantpurge.Plan{Kind: "purge"})
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := backupCipher()
	if err != nil {
		t.Fatal(err)
	}
	before, receipted, err := readBeforeImage(gcm, saved.Path)
	if err != nil || !receipted || before.Kind != "purge" {
		t.Fatalf("readBeforeImage = %+v, receipted=%v, err=%v", before, receipted, err)
	}
	if err := os.Remove(saved.Path + receiptSuffix); err != nil {
		t.Fatal(err)
	}
	if _, receipted, err := readBeforeImage(gcm, saved.Path); err != nil || receipted {
		t.Fatalf("an image without a receipt must be skipped: receipted=%v, err=%v", receipted, err)
	}
	if err := writeReceipt(directory, saved.Path+receiptSuffix, saved); err != nil {
		t.Fatal(err)
	}
	encrypted, err := os.ReadFile(saved.Path)
	if err != nil {
		t.Fatal(err)
	}
	encrypted[len(encrypted)-1] ^= 1
	if err := os.WriteFile(saved.Path, encrypted, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readBeforeImage(gcm, saved.Path); err == nil {
		t.Fatal("a tampered before-image was accepted")
	}
}

func TestBackupDirectoryMustBeAbsoluteOwnerOnlyAndOutsideGit(t *testing.T) {
	if err := checkBackupDirectory("relative/path"); err == nil {
		t.Error("a relative directory was accepted")
	}
	open, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(open, 0755); err != nil {
		t.Fatal(err)
	}
	if err := checkBackupDirectory(open); err == nil {
		t.Error("a group-readable directory was accepted")
	}
	inGit := filepath.Join(open, "repo")
	if err := os.MkdirAll(filepath.Join(inGit, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := checkBackupDirectory(inGit); err == nil {
		t.Error("a directory inside a Git checkout was accepted")
	}
}
