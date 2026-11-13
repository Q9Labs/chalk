package recorderfleetjournal

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

var testKey = recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}

func testNode(t *testing.T) recorderfleet.ManagedNode {
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return recorderfleet.ManagedNode{
		ProviderID: "p1", Name: "node-1", Phase: recorderfleet.PhaseBootstrapping, BootGeneration: 1,
		Identity: &recorderfleet.NodeIdentity{ProviderID: "p1", WorkerID: id.String(), Role: testKey.Role, BootGeneration: 1},
	}
}

func testJournal(t *testing.T, schema string) recorderfleet.Journal {
	journal := recorderfleet.NewJournal()
	journal.SchemaVersion = schema
	journal.Revision = 3
	journal.Nodes = map[string]recorderfleet.ManagedNode{"p1": testNode(t)}
	return journal
}

func writeEnvelope(t *testing.T, path string, key recorderfleet.PoolKey, journal recorderfleet.Journal) {
	encoded, err := json.Marshal(fileEnvelope{Key: key, Journal: journal})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLoadUnlocked(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, path string)
		key   recorderfleet.PoolKey
		want  error
	}{
		{"missing", func(*testing.T, string) {}, testKey, recorderfleet.ErrJournalNotFound},
		{"invalid key", func(*testing.T, string) {}, recorderfleet.PoolKey{}, recorderfleet.ErrInvalidConfig},
		{"directory", func(t *testing.T, path string) {
			if err := os.Mkdir(path, 0o700); err != nil {
				t.Fatal(err)
			}
		}, testKey, recorderfleet.ErrInvalidJournal},
		{"symlink", func(t *testing.T, path string) {
			target := path + ".target"
			writeEnvelope(t, target, testKey, testJournal(t, recorderfleet.JournalSchemaVersion))
			if err := os.Symlink(target, path); err != nil {
				t.Fatal(err)
			}
		}, testKey, recorderfleet.ErrInvalidJournal},
		{"empty", func(t *testing.T, path string) {
			if err := os.WriteFile(path, nil, 0o600); err != nil {
				t.Fatal(err)
			}
		}, testKey, recorderfleet.ErrInvalidJournal},
		{"oversize", func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte(strings.Repeat(" ", maximumJournalBytes+1)), 0o600); err != nil {
				t.Fatal(err)
			}
		}, testKey, recorderfleet.ErrInvalidJournal},
		{"not json", func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
				t.Fatal(err)
			}
		}, testKey, recorderfleet.ErrInvalidJournal},
		{"unknown field", func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte(`{"key":{},"journal":{},"extra":1}`), 0o600); err != nil {
				t.Fatal(err)
			}
		}, testKey, recorderfleet.ErrInvalidJournal},
		{"trailing data", func(t *testing.T, path string) {
			writeEnvelope(t, path, testKey, testJournal(t, recorderfleet.JournalSchemaVersion))
			file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			if _, err := file.WriteString(" {}"); err != nil {
				t.Fatal(err)
			}
		}, testKey, recorderfleet.ErrInvalidJournal},
		{"other key", func(t *testing.T, path string) {
			writeEnvelope(t, path, recorderfleet.PoolKey{Environment: "prod", Role: workeridentity.RoleCapture}, testJournal(t, recorderfleet.JournalSchemaVersion))
		}, testKey, recorderfleet.ErrInvalidJournal},
		{"current", func(t *testing.T, path string) {
			writeEnvelope(t, path, testKey, testJournal(t, recorderfleet.JournalSchemaVersion))
		}, testKey, nil},
		{"current invalid", func(t *testing.T, path string) {
			journal := testJournal(t, recorderfleet.JournalSchemaVersion)
			journal.NextBootGeneration = 0
			writeEnvelope(t, path, testKey, journal)
		}, testKey, recorderfleet.ErrInvalidJournal},
		{"unknown schema", func(t *testing.T, path string) {
			writeEnvelope(t, path, testKey, testJournal(t, "recorder_fleet_journal.v9"))
		}, testKey, recorderfleet.ErrInvalidJournal},
		{"legacy", func(t *testing.T, path string) {
			writeEnvelope(t, path, testKey, testJournal(t, recorderfleet.LegacyJournalSchemaVersion))
		}, testKey, nil},
		{"legacy node without identity", func(t *testing.T, path string) {
			journal := testJournal(t, recorderfleet.LegacyJournalSchemaVersion)
			node := journal.Nodes["p1"]
			node.Identity = nil
			node.Phase = recorderfleet.PhaseDeleting
			journal.Nodes["p1"] = node
			writeEnvelope(t, path, testKey, journal)
		}, testKey, recorderfleet.ErrInvalidJournal},
		{"legacy awaiting bootstrap", func(t *testing.T, path string) {
			journal := testJournal(t, recorderfleet.LegacyJournalSchemaVersion)
			node := journal.Nodes["p1"]
			node.Phase = recorderfleet.PhaseAwaitingBootstrap
			journal.Nodes["p1"] = node
			writeEnvelope(t, path, testKey, journal)
		}, testKey, recorderfleet.ErrInvalidJournal},
		{"legacy invalid after migration", func(t *testing.T, path string) {
			journal := testJournal(t, recorderfleet.LegacyJournalSchemaVersion)
			journal.NextBootGeneration = 0
			writeEnvelope(t, path, testKey, journal)
		}, testKey, recorderfleet.ErrInvalidJournal},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "journal.json")
			tc.setup(t, path)
			store, err := New(path)
			if err != nil {
				t.Fatal(err)
			}
			journal, err := store.Load(context.Background(), tc.key)
			if !errors.Is(err, tc.want) || (tc.want == nil) != (err == nil) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
			if err == nil && (journal.SchemaVersion != recorderfleet.JournalSchemaVersion || journal.Revision != 3 || len(journal.Nodes) != 1) {
				t.Fatalf("unexpected journal %+v", journal)
			}
		})
	}
}

func TestLoadMigratesLegacyFileOnDisk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.json")
	writeEnvelope(t, path, testKey, testJournal(t, recorderfleet.LegacyJournalSchemaVersion))
	store, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(context.Background(), testKey); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var envelope fileEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Journal.SchemaVersion != recorderfleet.JournalSchemaVersion || envelope.Key != testKey {
		t.Fatalf("file not migrated: %+v", envelope)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, err %v", info.Mode(), err)
	}
}

func TestLoadFilesystemFailures(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permission checks do not apply to root")
	}
	t.Run("stat", func(t *testing.T) {
		dir := t.TempDir()
		blocker := filepath.Join(dir, "file")
		if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		store, _ := New(filepath.Join(blocker, "journal.json"))
		_, err := store.Load(context.Background(), testKey)
		if err == nil || !strings.HasPrefix(err.Error(), "stat recorder fleet journal: ") {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("open", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "journal.json")
		writeEnvelope(t, path, testKey, testJournal(t, recorderfleet.JournalSchemaVersion))
		if err := os.Chmod(path, 0); err != nil {
			t.Fatal(err)
		}
		store, _ := New(path)
		_, err := store.Load(context.Background(), testKey)
		if err == nil || !strings.HasPrefix(err.Error(), "open recorder fleet journal: ") {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("migrate write", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "journal.json")
		writeEnvelope(t, path, testKey, testJournal(t, recorderfleet.LegacyJournalSchemaVersion))
		if err := os.Chmod(dir, 0o500); err != nil {
			t.Fatal(err)
		}
		defer os.Chmod(dir, 0o700)
		store, _ := New(path)
		_, err := store.Load(context.Background(), testKey)
		if err == nil || !strings.HasPrefix(err.Error(), "migrate recorder fleet journal: ") {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestSaveRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "journal.json")
	store, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	journal := testJournal(t, recorderfleet.JournalSchemaVersion)
	journal.Revision = 1
	if _, err := store.Save(context.Background(), testKey, 1, journal); !errors.Is(err, recorderfleet.ErrInvalidJournal) {
		t.Fatalf("error = %v", err)
	}
	if _, err := store.Save(context.Background(), testKey, 0, journal); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(context.Background(), testKey)
	if err != nil || loaded.Revision != 1 {
		t.Fatalf("loaded %+v, %v", loaded, err)
	}
	journal.Revision = 2
	if _, err := store.Save(context.Background(), testKey, 0, journal); !errors.Is(err, recorderfleet.ErrInvalidJournal) {
		t.Fatalf("error = %v", err)
	}
	journal.Revision = 3
	if _, err := store.Save(context.Background(), testKey, 2, journal); !errors.Is(err, recorderfleet.ErrJournalConflict) {
		t.Fatalf("error = %v", err)
	}
}
