package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
	"os"
	"path/filepath"
	"testing"
)

func TestShortBackupAuthenticatedBeforeImages(t *testing.T) {
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	key := make([]byte, 32)
	t.Setenv("CHALK_TENANT_PURGE_BACKUP_KEY", base64.StdEncoding.EncodeToString(key))
	// macOS /var is a symlink; the sink deliberately requires the resolved path.
	directory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	sink, err := shortBackupSink(directory)
	if err != nil {
		t.Fatal(err)
	}
	plan := tenantpurge.Plan{Version: 1, Kind: "purge", Tables: []tenantpurge.Table{{Name: "users", Count: 1, Rows: []tenantpurge.Row{{Key: json.RawMessage(`{"id":"fixture"}`), Value: json.RawMessage(`{"private":"before-value"}`)}}}}}
	receipt, err := sink(context.Background(), plan)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := os.ReadFile(receipt.Path)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	magic := []byte("CHALKTPB1")
	raw, err := gcm.Open(nil, encrypted[9:21], encrypted[21:], magic)
	if err != nil {
		t.Fatal(err)
	}
	var restored tenantpurge.Plan
	if err := json.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	if string(restored.Tables[0].Rows[0].Value) != string(plan.Tables[0].Rows[0].Value) {
		t.Fatal("before-image not exact")
	}
	info, err := os.Stat(receipt.Path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private file: %v", err)
	}
	if _, err := os.Stat(receipt.Path + ".receipt.private.json"); err != nil {
		t.Fatal("missing durable backup receipt")
	}
	encrypted[len(encrypted)-1] ^= 1
	if _, err := gcm.Open(nil, encrypted[9:21], encrypted[21:], magic); err == nil {
		t.Fatal("tampered backup accepted")
	}
	if err := os.Mkdir(filepath.Join(directory, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := shortBackupSink(directory); err == nil {
		t.Fatal("Git backup accepted")
	}
}

func TestShortBackupCarriesOnlyAuthenticatedScopeSeeds(t *testing.T) {
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CHALK_TENANT_PURGE_BACKUP_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	scope := tenantpurge.Scope{Delete: []tenantpurge.Identity{{ID: "approved", Name: "Fixture"}}, Keep: []tenantpurge.Identity{{ID: "kept", Name: "Fixture"}}}
	before := tenantpurge.Plan{Kind: "purge", Scope: scope, Tables: []tenantpurge.Table{{Name: "memberships", Rows: []tenantpurge.Row{{Value: json.RawMessage(`{"tenant_id":"approved","user_id":"late-user"}`)}}}, {Name: "artifact_jobs", Rows: []tenantpurge.Row{{Value: json.RawMessage(`{"tenant_id":"approved","journey_id":"late-journey"}`)}}}}}
	sink, err := shortBackupSink(directory)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := sink(context.Background(), before)
	if err != nil {
		t.Fatal(err)
	}
	plan := tenantpurge.Plan{Kind: "purge", Scope: scope}
	if err := carryShortBeforeImages(directory, &plan); err != nil {
		t.Fatal(err)
	}
	if len(plan.DeferredSeeds.Users) != 1 || plan.DeferredSeeds.Users[0] != "late-user" || len(plan.DeferredSeeds.Journeys) != 1 || plan.DeferredSeeds.Journeys[0] != "late-journey" {
		t.Fatalf("live seeds lost: %+v", plan.DeferredSeeds)
	}
	data, err := os.ReadFile(receipt.Path)
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)-1] ^= 1
	if err := os.WriteFile(receipt.Path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := carryShortBeforeImages(directory, &plan); err == nil {
		t.Fatal("tampered seeds accepted")
	}
}
