package main

import (
	"strings"
	"testing"
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
