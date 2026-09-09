package recorderfleetissuer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

const (
	stateSchemaVersion  = "recorder_fleet_issuer_state.v2"
	legacySchemaVersion = "recorder_fleet_issuer_state.v1"
)

type Store struct {
	mu    sync.Mutex
	path  string
	state persistedState
}

type persistedState struct {
	SchemaVersion string                   `json:"schema_version"`
	Registrations map[string]*registration `json:"registrations"`
	Abandonments  map[string]*abandonment  `json:"abandonments"`
	Challenges    map[string]*challenge    `json:"challenges"`
}

type abandonment struct {
	Request   recorderfleet.BootstrapRequest `json:"request"`
	RevokedAt time.Time                      `json:"revoked_at"`
}

type registration struct {
	Request             recorderfleet.BootstrapRequest `json:"request"`
	Identity            recorderfleet.NodeIdentity     `json:"identity"`
	Certificates        map[string]certificateRecord   `json:"certificates"`
	CurrentCertificates map[string]string              `json:"current_certificates"`
	RevokedAt           *time.Time                     `json:"revoked_at,omitempty"`
}

type certificateRecord struct {
	SerialNumber string    `json:"serial_number"`
	CSRHash      string    `json:"csr_hash"`
	PEM          string    `json:"pem"`
	NotAfter     time.Time `json:"not_after"`
	IssuedAt     time.Time `json:"issued_at"`
}

type challenge struct {
	ProviderID      string     `json:"provider_id"`
	ReleaseID       string     `json:"release_id"`
	ImageDigest     string     `json:"image_digest"`
	BootGeneration  uint64     `json:"boot_generation"`
	InventoryDigest string     `json:"inventory_digest"`
	CSRHash         string     `json:"csr_hash"`
	PeerIP          string     `json:"peer_ip"`
	ExpiresAt       time.Time  `json:"expires_at"`
	ConsumedAt      *time.Time `json:"consumed_at,omitempty"`
}

func OpenStore(path string) (*Store, error) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, ErrInvalidConfig
	}
	store := &Store{path: path, state: newState()}
	encoded, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("create issuer state directory: %w", err)
		}
		if err := store.persistLocked(); err != nil {
			return nil, err
		}
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read issuer state: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&store.state); err != nil || store.state.Registrations == nil || store.state.Challenges == nil {
		return nil, fmt.Errorf("%w: invalid persisted issuer state", ErrInvalidConfig)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: invalid persisted issuer state", ErrInvalidConfig)
	}
	switch store.state.SchemaVersion {
	case legacySchemaVersion:
		store.state.SchemaVersion = stateSchemaVersion
		store.state.Abandonments = make(map[string]*abandonment)
		if err := store.persistLocked(); err != nil {
			return nil, fmt.Errorf("migrate issuer state: %w", err)
		}
	case stateSchemaVersion:
		if store.state.Abandonments == nil {
			return nil, fmt.Errorf("%w: invalid persisted issuer state", ErrInvalidConfig)
		}
		for providerID, tombstone := range store.state.Abandonments {
			if tombstone == nil || tombstone.Request.ProviderID != providerID || tombstone.Request.Validate() != nil || tombstone.RevokedAt.IsZero() {
				return nil, fmt.Errorf("%w: invalid persisted issuer state", ErrInvalidConfig)
			}
			if registration := store.state.Registrations[providerID]; registration != nil && registration.Request != tombstone.Request {
				return nil, fmt.Errorf("%w: invalid persisted issuer state", ErrInvalidConfig)
			}
		}
	default:
		return nil, fmt.Errorf("%w: invalid persisted issuer state", ErrInvalidConfig)
	}
	return store, nil
}

func newState() persistedState {
	return persistedState{
		SchemaVersion: stateSchemaVersion,
		Registrations: make(map[string]*registration),
		Abandonments:  make(map[string]*abandonment),
		Challenges:    make(map[string]*challenge),
	}
}

func (s *Store) update(update func(*persistedState) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, err := cloneState(s.state)
	if err != nil {
		return err
	}
	if err := update(&s.state); err != nil {
		s.state = previous
		return err
	}
	if err := s.persistLocked(); err != nil {
		s.state = previous
		return err
	}
	return nil
}

func cloneState(state persistedState) (persistedState, error) {
	encoded, err := json.Marshal(state)
	if err != nil {
		return persistedState{}, fmt.Errorf("clone issuer state: %w", err)
	}
	var cloned persistedState
	if err := json.Unmarshal(encoded, &cloned); err != nil {
		return persistedState{}, fmt.Errorf("clone issuer state: %w", err)
	}
	return cloned, nil
}

func (s *Store) read(read func(persistedState) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return read(s.state)
}

func (s *Store) persistLocked() error {
	encoded, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode issuer state: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(s.path), ".issuer-state-*")
	if err != nil {
		return fmt.Errorf("create issuer state transaction: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("protect issuer state transaction: %w", err)
	}
	if _, err := temporary.Write(encoded); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write issuer state transaction: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync issuer state transaction: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close issuer state transaction: %w", err)
	}
	if err := os.Rename(temporaryPath, s.path); err != nil {
		return fmt.Errorf("commit issuer state transaction: %w", err)
	}
	directory, err := os.Open(filepath.Dir(s.path))
	if err != nil {
		return fmt.Errorf("open issuer state directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync issuer state directory: %w", err)
	}
	return nil
}
