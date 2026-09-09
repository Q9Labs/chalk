package recorderfleetjournal

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestStorePersistsAtomicJournalAndRejectsStaleRevision(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "capture.json")
	store, err := New(path)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	key := recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}
	if _, err := store.Load(t.Context(), key); !errors.Is(err, recorderfleet.ErrJournalNotFound) {
		t.Fatalf("missing load error = %v", err)
	}

	journal := recorderfleet.NewJournal()
	journal.Revision = 1
	saved, err := store.Save(t.Context(), key, 0, journal)
	if err != nil || saved.Revision != 1 {
		t.Fatalf("save = %+v, %v", saved, err)
	}
	reopened, err := New(path)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	loaded, err := reopened.Load(t.Context(), key)
	if err != nil || loaded.Revision != 1 || loaded.NextBootGeneration != 1 {
		t.Fatalf("load = %+v, %v", loaded, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat journal: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("journal permissions = %#o, want 0600", info.Mode().Perm())
	}

	stale := recorderfleet.NewJournal()
	stale.Revision = 1
	if _, err := reopened.Save(t.Context(), key, 0, stale); !errors.Is(err, recorderfleet.ErrJournalConflict) {
		t.Fatalf("stale save error = %v", err)
	}
	loadedAgain, err := reopened.Load(t.Context(), key)
	if err != nil || loadedAgain.Revision != 1 {
		t.Fatalf("stale save changed journal: %+v, %v", loadedAgain, err)
	}
}

func TestStoreRoundTripsFencedIdentityWithoutSecrets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "capture.json")
	store, err := New(path)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	key := recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}
	drainingAt := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	journal := recorderfleet.NewJournal()
	journal.Revision = 1
	journal.Nodes["123"] = recorderfleet.ManagedNode{
		ProviderID: "123", Name: "chalk-recorder-capture-staging-1-release", Phase: recorderfleet.PhaseDraining,
		BootGeneration: 1, DrainStartedAt: &drainingAt,
		Identity: &recorderfleet.NodeIdentity{
			ProviderID: "123", WorkerID: "55555555-5555-4555-8555-555555555555",
			Role: workeridentity.RoleCapture, BootGeneration: 1,
		},
	}
	if _, err := store.Save(t.Context(), key, 0, journal); err != nil {
		t.Fatalf("save identity: %v", err)
	}
	loaded, err := store.Load(t.Context(), key)
	if err != nil {
		t.Fatalf("load identity: %v", err)
	}
	if loaded.Nodes["123"].Identity == nil || loaded.Nodes["123"].Identity.WorkerID != journal.Nodes["123"].Identity.WorkerID {
		t.Fatalf("identity did not round trip: %+v", loaded.Nodes["123"])
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read journal: %v", err)
	}
	for _, forbidden := range []string{"assertion", "token", "credential", "private_key"} {
		if stringContains(string(content), forbidden) {
			t.Fatalf("journal contains forbidden secret field %q", forbidden)
		}
	}
}

func TestStoreRejectsCorruptAndSymlinkJournals(t *testing.T) {
	directory := t.TempDir()
	key := recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}
	corruptPath := filepath.Join(directory, "corrupt.json")
	if err := os.WriteFile(corruptPath, []byte(`{"key":`), 0o600); err != nil {
		t.Fatalf("write corrupt journal: %v", err)
	}
	corrupt, _ := New(corruptPath)
	if _, err := corrupt.Load(t.Context(), key); !errors.Is(err, recorderfleet.ErrInvalidJournal) {
		t.Fatalf("corrupt load error = %v", err)
	}

	target := filepath.Join(directory, "target.json")
	if err := os.WriteFile(target, []byte(`{}`), 0o600); err != nil {
		t.Fatalf("write target: %v", err)
	}
	symlinkPath := filepath.Join(directory, "symlink.json")
	if err := os.Symlink(target, symlinkPath); err != nil {
		t.Fatalf("create symlink: %v", err)
	}
	symlink, _ := New(symlinkPath)
	if _, err := symlink.Load(t.Context(), key); !errors.Is(err, recorderfleet.ErrInvalidJournal) {
		t.Fatalf("symlink load error = %v", err)
	}
}

func TestStoreMigratesSafeLegacyJournalAndRejectsAmbiguousBootstrap(t *testing.T) {
	key := recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}
	directory := t.TempDir()
	legacy := recorderfleet.NewJournal()
	legacy.SchemaVersion = recorderfleet.LegacyJournalSchemaVersion
	legacy.Revision = 4
	legacy.Nodes["provider-6"] = recorderfleet.ManagedNode{
		ProviderID: "provider-6", Name: "capture-6", Phase: recorderfleet.PhaseBootstrapping, BootGeneration: 6,
		Identity: &recorderfleet.NodeIdentity{
			ProviderID: "provider-6", WorkerID: "55555555-5555-4555-8555-555555555555",
			Role: workeridentity.RoleCapture, BootGeneration: 6,
		},
	}

	safePath := filepath.Join(directory, "safe.json")
	writeJournalEnvelope(t, safePath, key, legacy)
	safeStore, _ := New(safePath)
	loaded, err := safeStore.Load(t.Context(), key)
	if err != nil || loaded.SchemaVersion != recorderfleet.JournalSchemaVersion || loaded.Revision != legacy.Revision {
		t.Fatalf("migrated journal/error = %+v/%v", loaded, err)
	}
	encoded, err := os.ReadFile(safePath)
	if err != nil || !stringContains(string(encoded), recorderfleet.JournalSchemaVersion) {
		t.Fatalf("persisted migration = %q, %v", encoded, err)
	}

	drainStartedAt := time.Date(2026, 9, 9, 11, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name           string
		phase          recorderfleet.Phase
		drainStartedAt *time.Time
	}{
		{name: "awaiting bootstrap", phase: recorderfleet.PhaseAwaitingBootstrap},
		{name: "draining", phase: recorderfleet.PhaseDraining, drainStartedAt: &drainStartedAt},
		{name: "identity revoked", phase: recorderfleet.PhaseIdentityRevoked, drainStartedAt: &drainStartedAt},
		{name: "deleting", phase: recorderfleet.PhaseDeleting, drainStartedAt: &drainStartedAt},
	} {
		t.Run(test.name, func(t *testing.T) {
			ambiguousPath := filepath.Join(directory, string(test.phase)+".json")
			ambiguous := legacy
			ambiguous.Nodes = map[string]recorderfleet.ManagedNode{"provider-7": {
				ProviderID: "provider-7", Name: "capture-7", Phase: test.phase, BootGeneration: 7,
				DrainStartedAt: test.drainStartedAt,
			}}
			writeJournalEnvelope(t, ambiguousPath, key, ambiguous)
			before, _ := os.ReadFile(ambiguousPath)
			ambiguousStore, _ := New(ambiguousPath)
			if _, err := ambiguousStore.Load(t.Context(), key); !errors.Is(err, recorderfleet.ErrInvalidJournal) {
				t.Fatalf("ambiguous legacy load error = %v", err)
			}
			after, _ := os.ReadFile(ambiguousPath)
			if string(after) != string(before) || !stringContains(string(after), recorderfleet.LegacyJournalSchemaVersion) {
				t.Fatalf("ambiguous legacy journal was mutated: %s", after)
			}
		})
	}
}

func writeJournalEnvelope(t *testing.T, path string, key recorderfleet.PoolKey, journal recorderfleet.Journal) {
	t.Helper()
	encoded, err := json.Marshal(fileEnvelope{Key: key, Journal: journal})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

func stringContains(value, substring string) bool {
	for index := 0; index+len(substring) <= len(value); index++ {
		if value[index:index+len(substring)] == substring {
			return true
		}
	}
	return false
}
