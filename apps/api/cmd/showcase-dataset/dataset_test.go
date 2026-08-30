package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestEmbeddedDatasetPreservesPendingCaptureSlots(t *testing.T) {
	value, err := loadDataset(options{})
	if err != nil {
		t.Fatalf("load embedded dataset: %v", err)
	}
	if len(value.PendingAssetKeys) != 9 {
		t.Fatalf("pending asset count = %d, want 9", len(value.PendingAssetKeys))
	}
	for key := range value.PendingAssetKeys {
		if key == "" {
			t.Fatal("pending asset key is empty")
		}
	}
	ids := buildIDs(value)
	for _, item := range value.Manifest.Records.Episodes {
		refs := buildArtifactMetadata(value, ids, item)
		for key := range value.PendingAssetKeys {
			if containsArtifactAssetKey(refs, key) {
				t.Fatalf("Episode %s references pending asset %s", item.ExternalKey, key)
			}
		}
	}
}

func TestDeterministicIDsAndControlSnapshots(t *testing.T) {
	value, err := loadDataset(options{})
	if err != nil {
		t.Fatalf("load embedded dataset: %v", err)
	}
	ids := buildIDs(value)
	item := value.Manifest.Records.Episodes[0]
	snapshot, wire, digest, err := snapshotForEpisode(value, ids, item, nil, "ended", 6)
	if err != nil {
		t.Fatalf("build control snapshot: %v", err)
	}
	if snapshot["status"] != "ended" || string(wire) == "" || digest == [32]byte{} {
		t.Fatal("control snapshot did not produce the expected ended state")
	}
	if ids.OrganizationID != buildIDs(value).OrganizationID {
		t.Fatal("organization id is not deterministic")
	}
}

func TestBuiltRecordingReferenceUsesTenantScopedStorageKey(t *testing.T) {
	value, err := loadDataset(options{})
	if err != nil {
		t.Fatalf("load embedded dataset: %v", err)
	}
	ids := buildIDs(value)
	item := value.EpisodeByKey["chalk-episode-004"]
	refs := buildArtifactMetadata(value, ids, item)
	recording, ok := refs["recording"].(map[string]any)
	if !ok {
		t.Fatal("built Episode did not include a recording reference")
	}
	tenantID := ids.TenantIDs[item.TenantKey]
	prefix := "tenants/" + tenantID + "/recordings/"
	storageKey, ok := recording["storageKey"].(string)
	if !ok || !strings.HasPrefix(storageKey, prefix) {
		t.Fatalf("recording storage key = %q, want prefix %q", storageKey, prefix)
	}
}

func containsArtifactAssetKey(refs map[string]any, pendingKey string) bool {
	for _, value := range refs {
		ref, ok := value.(map[string]any)
		if ok && ref["assetKey"] == pendingKey {
			return true
		}
	}
	return false
}

func TestPlanDoesNotOpenDatabase(t *testing.T) {
	value, err := loadDataset(options{})
	if err != nil {
		t.Fatalf("load embedded dataset: %v", err)
	}
	result := planDataset(value, options{environment: "current", organizationKey: value.Manifest.Records.Organizations[0].ExternalKey})
	if result.Status != "planned" || result.Counts["pendingAssets"] != 9 {
		t.Fatalf("unexpected plan result: %+v", result)
	}
}

func TestDestructiveCommandsRequireExplicitConfirmation(t *testing.T) {
	organizationKey := "chalk-showcase-episode-network"
	if _, err := parseOptions([]string{
		"apply",
		"--environment", "local",
		"--organization-key", organizationKey,
		"--create-organization",
		"--database-url", "postgres://example.invalid/chalk",
		"--owner-user-id", "owner",
	}); err == nil || !strings.Contains(err.Error(), "--confirm-production") {
		t.Fatalf("apply without confirmation error = %v", err)
	}
	if _, err := parseOptions([]string{
		"remove",
		"--environment", "local",
		"--organization-key", organizationKey,
		"--confirm-organization", "organization-id",
		"--database-url", "postgres://example.invalid/chalk",
	}); err == nil || !strings.Contains(err.Error(), "--confirm-production") {
		t.Fatalf("remove without confirmation error = %v", err)
	}
	if _, err := parseOptions([]string{
		"apply",
		"--environment", "local",
		"--organization-key", organizationKey,
		"--create-organization",
		"--database-url", "postgres://example.invalid/chalk",
		"--owner-user-id", "owner",
		"--confirm-production",
	}); err != nil {
		t.Fatalf("confirmed local apply parse error = %v", err)
	}
}

func TestLifecycleEventBytesUseTheStoredEventEnvelope(t *testing.T) {
	joinPayload := map[string]any{
		"participant_id":     uuid.MustParse("00000000-0000-0000-0000-000000000001"),
		"display_name":       "Noor Eman Salem",
		"role":               "owner",
		"admission_revision": 1,
	}
	digest := [32]byte{1}
	joinBytes, err := json.Marshal(joinPayload)
	if err != nil {
		t.Fatalf("encode join payload: %v", err)
	}
	got, err := lifecycleEventBytes(
		"participant_joined",
		0,
		1,
		joinPayload,
		uuid.MustParse("00000000-0000-0000-0000-000000000002"),
		uuid.MustParse("00000000-0000-0000-0000-000000000003"),
		digest,
	)
	if err != nil {
		t.Fatalf("encode stored join event: %v", err)
	}
	if got-len(joinBytes) != 311 {
		t.Fatalf("stored join event overhead = %d, want 311", got-len(joinBytes))
	}

	endPayload := map[string]any{"reason": "ended_by_participant"}
	endBytes, err := json.Marshal(endPayload)
	if err != nil {
		t.Fatalf("encode end payload: %v", err)
	}
	got, err = lifecycleEventBytes(
		"episode_ended",
		5,
		6,
		endPayload,
		uuid.MustParse("00000000-0000-0000-0000-000000000004"),
		uuid.MustParse("00000000-0000-0000-0000-000000000005"),
		digest,
	)
	if err != nil {
		t.Fatalf("encode stored end event: %v", err)
	}
	if got-len(endBytes) != 306 {
		t.Fatalf("stored end event overhead = %d, want 306", got-len(endBytes))
	}
}
