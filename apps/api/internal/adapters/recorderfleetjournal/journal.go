package recorderfleetjournal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

const maximumJournalBytes = 1 << 20

// Store is an atomic local journal for one externally single-leader
// reconciler. Revision checks reject stale in-process transitions; deployments
// must still run exactly one controller instance for a journal path.
type Store struct {
	path string
	mu   sync.Mutex
}

func New(path string) (*Store, error) {
	if path == "" || filepath.Clean(path) == "." {
		return nil, recorderfleet.ErrInvalidConfig
	}
	return &Store{path: filepath.Clean(path)}, nil
}

func (s *Store) Load(ctx context.Context, key recorderfleet.PoolKey) (recorderfleet.Journal, error) {
	if s == nil || ctx.Err() != nil {
		if ctx.Err() != nil {
			return recorderfleet.Journal{}, ctx.Err()
		}
		return recorderfleet.Journal{}, recorderfleet.ErrInvalidConfig
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadUnlocked(key)
}

func (s *Store) Save(ctx context.Context, key recorderfleet.PoolKey, expectedRevision uint64, journal recorderfleet.Journal) (recorderfleet.Journal, error) {
	if s == nil || ctx.Err() != nil {
		if ctx.Err() != nil {
			return recorderfleet.Journal{}, ctx.Err()
		}
		return recorderfleet.Journal{}, recorderfleet.ErrInvalidConfig
	}
	if err := key.Validate(); err != nil || journal.Revision != expectedRevision+1 || journal.Validate(key) != nil {
		return recorderfleet.Journal{}, recorderfleet.ErrInvalidJournal
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.loadUnlocked(key)
	if errors.Is(err, recorderfleet.ErrJournalNotFound) {
		if expectedRevision != 0 {
			return recorderfleet.Journal{}, recorderfleet.ErrJournalConflict
		}
	} else if err != nil {
		return recorderfleet.Journal{}, err
	} else if current.Revision != expectedRevision {
		return recorderfleet.Journal{}, recorderfleet.ErrJournalConflict
	}

	envelope := fileEnvelope{Key: key, Journal: journal}
	encoded, err := json.Marshal(envelope)
	if err != nil || len(encoded) > maximumJournalBytes {
		return recorderfleet.Journal{}, recorderfleet.ErrInvalidJournal
	}
	if err := writeAtomic(s.path, encoded); err != nil {
		return recorderfleet.Journal{}, fmt.Errorf("write recorder fleet journal: %w", err)
	}
	return cloneJournal(journal)
}

func (s *Store) loadUnlocked(key recorderfleet.PoolKey) (recorderfleet.Journal, error) {
	if err := key.Validate(); err != nil {
		return recorderfleet.Journal{}, err
	}
	info, err := os.Lstat(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return recorderfleet.Journal{}, recorderfleet.ErrJournalNotFound
	}
	if err != nil {
		return recorderfleet.Journal{}, fmt.Errorf("stat recorder fleet journal: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 || info.Size() > maximumJournalBytes {
		return recorderfleet.Journal{}, recorderfleet.ErrInvalidJournal
	}
	file, err := os.Open(s.path)
	if err != nil {
		return recorderfleet.Journal{}, fmt.Errorf("open recorder fleet journal: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, maximumJournalBytes+1))
	decoder.DisallowUnknownFields()
	var envelope fileEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return recorderfleet.Journal{}, recorderfleet.ErrInvalidJournal
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return recorderfleet.Journal{}, recorderfleet.ErrInvalidJournal
	}
	if envelope.Key != key {
		return recorderfleet.Journal{}, recorderfleet.ErrInvalidJournal
	}
	if envelope.Journal.SchemaVersion == recorderfleet.LegacyJournalSchemaVersion {
		for _, node := range envelope.Journal.Nodes {
			if node.Identity == nil || node.Phase == recorderfleet.PhaseAwaitingBootstrap {
				return recorderfleet.Journal{}, recorderfleet.ErrInvalidJournal
			}
		}
		envelope.Journal.SchemaVersion = recorderfleet.JournalSchemaVersion
		if envelope.Journal.Validate(key) != nil {
			return recorderfleet.Journal{}, recorderfleet.ErrInvalidJournal
		}
		encoded, err := json.Marshal(envelope)
		if err != nil || len(encoded) > maximumJournalBytes {
			return recorderfleet.Journal{}, recorderfleet.ErrInvalidJournal
		}
		if err := writeAtomic(s.path, encoded); err != nil {
			return recorderfleet.Journal{}, fmt.Errorf("migrate recorder fleet journal: %w", err)
		}
	} else if envelope.Journal.Validate(key) != nil {
		return recorderfleet.Journal{}, recorderfleet.ErrInvalidJournal
	}
	return cloneJournal(envelope.Journal)
}

func writeAtomic(path string, content []byte) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	directoryInfo, err := os.Lstat(directory)
	if err != nil || !directoryInfo.IsDir() || directoryInfo.Mode()&os.ModeSymlink != 0 {
		return recorderfleet.ErrInvalidJournal
	}
	temporary, err := os.CreateTemp(directory, ".recorder-fleet-journal-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	removeTemporary := true
	defer func() {
		_ = temporary.Close()
		if removeTemporary {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	if _, err := temporary.Write(content); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	removeTemporary = false
	directoryHandle, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer directoryHandle.Close()
	return directoryHandle.Sync()
}

func cloneJournal(journal recorderfleet.Journal) (recorderfleet.Journal, error) {
	encoded, err := json.Marshal(journal)
	if err != nil {
		return recorderfleet.Journal{}, recorderfleet.ErrInvalidJournal
	}
	var cloned recorderfleet.Journal
	if err := json.Unmarshal(encoded, &cloned); err != nil {
		return recorderfleet.Journal{}, recorderfleet.ErrInvalidJournal
	}
	return cloned, nil
}

type fileEnvelope struct {
	Key     recorderfleet.PoolKey `json:"key"`
	Journal recorderfleet.Journal `json:"journal"`
}

var _ recorderfleet.JournalStore = (*Store)(nil)
