package apikeys

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// conflictingRepository rejects the first prefixConflicts creations, then accepts one.
type conflictingRepository struct {
	Repository
	prefixConflicts int
	creations       int
	idempotent      bool
}

func (r *conflictingRepository) Create(_ context.Context, input CreateRecordInput) (Record, error) {
	r.creations++
	if r.creations <= r.prefixConflicts {
		return Record{}, ErrPrefixConflict
	}
	return Record{KeyHash: input.KeyHash, Key: Key{ID: input.ID, TenantID: input.TenantID, Name: input.Name}}, nil
}

type idempotentRepository struct {
	conflictingRepository
	replayed bool
}

func (r *idempotentRepository) CreateIdempotent(ctx context.Context, input CreateRecordInput) (Record, bool, error) {
	r.idempotent = true
	record, err := r.conflictingRepository.Create(ctx, input)
	return record, r.replayed, err
}

func (r *idempotentRepository) RotateIdempotent(context.Context, RotateRecordInput) (Record, bool, error) {
	return Record{}, false, errors.New("not used")
}

func createInput(t *testing.T, now time.Time) CreateInput {
	t.Helper()
	tenantID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return CreateInput{TenantID: tenantID, Name: "ci", Scopes: []authentication.Scope{authentication.ScopeTenantsRead}, ExpiresAt: now.Add(time.Hour)}
}

func TestCreateRetriesAPrefixConflictWithANewCredential(t *testing.T) {
	now := time.Now()
	repository := &conflictingRepository{prefixConflicts: 2}
	service := NewService(repository, Config{Now: func() time.Time { return now }})

	result, err := service.Create(context.Background(), createInput(t, now))
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if repository.creations != 3 {
		t.Fatalf("creations = %d, want 3", repository.creations)
	}
	if result.RawKey == "" || result.Replayed {
		t.Fatalf("result = %+v, want a raw key on a first creation", result)
	}
}

func TestCreateGivesUpAfterTheMaximumPrefixAttempts(t *testing.T) {
	now := time.Now()
	repository := &conflictingRepository{prefixConflicts: MaxPrefixAttempts + 1}
	service := NewService(repository, Config{Now: func() time.Time { return now }})

	if _, err := service.Create(context.Background(), createInput(t, now)); !errors.Is(err, ErrPrefixConflict) {
		t.Fatalf("Create() error = %v, want ErrPrefixConflict", err)
	}
	if repository.creations != MaxPrefixAttempts {
		t.Fatalf("creations = %d, want %d", repository.creations, MaxPrefixAttempts)
	}
}

func TestCreateWithRequestKeyNeedsAnIdempotentRepository(t *testing.T) {
	now := time.Now()
	service := NewService(&conflictingRepository{}, Config{Now: func() time.Time { return now }})
	input := createInput(t, now)
	input.RequestKey = "request-key-0123456789"

	if _, err := service.Create(context.Background(), input); err == nil {
		t.Fatal("Create() succeeded without an idempotent repository")
	}
}

func TestReplayedCreationHidesTheRawKey(t *testing.T) {
	now := time.Now()
	repository := &idempotentRepository{replayed: true}
	service := NewService(repository, Config{Now: func() time.Time { return now }})
	input := createInput(t, now)
	input.RequestKey = "request-key-0123456789"

	result, err := service.Create(context.Background(), input)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if !repository.idempotent || !result.Replayed || result.RawKey != "" {
		t.Fatalf("result = %+v, idempotent = %v; want a replay without a raw key", result, repository.idempotent)
	}
}
