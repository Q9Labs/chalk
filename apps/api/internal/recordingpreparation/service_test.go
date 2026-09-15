package recordingpreparation

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPreparationWindowDoesNotPromiseEarlyOrExpiredReadiness(t *testing.T) {
	start := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name     string
		now      time.Time
		state    State
		capacity bool
		want     State
	}{
		{"before window", start.Add(-PreparationWindow - time.Nanosecond), Scheduled, true, Scheduled},
		{"window opens", start.Add(-PreparationWindow), Scheduled, true, Ready},
		{"capacity exhausted", start, Scheduled, false, Warming},
		{"grace", start.Add(NoShowGrace - time.Nanosecond), Scheduled, true, Ready},
		{"no show", start.Add(NoShowGrace), Scheduled, true, Expired},
		{"active recording", start.Add(time.Hour), Consumed, true, Consumed},
		{"canceled", start, Canceled, true, Canceled},
	} {
		t.Run(test.name, func(t *testing.T) {
			preparation := Preparation{StartsAt: start, State: test.state, Ready: test.capacity, CapacityAvailable: test.capacity}.At(test.now)
			if preparation.State != test.want || preparation.Ready != (test.want == Ready) {
				t.Fatalf("preparation = %+v, want state %s", preparation, test.want)
			}
		})
	}
}

func TestPreparationChecksSpacePolicyBeforePersisting(t *testing.T) {
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name      string
		space     spaces.Space
		readError error
	}{
		{"disabled", spaces.Space{RecordingPolicy: artifactpolicy.RecordingDisabled}, nil},
		{"archived", spaces.Space{RecordingPolicy: artifactpolicy.RecordingManual, ArchivedAt: &now}, nil},
		{"missing", spaces.Space{}, spaces.ErrSpaceNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &preparationRepositoryStub{}
			service := NewService(repository, preparationSpaceStub{space: test.space, err: test.readError})
			service.now = func() time.Time { return now }
			_, err := service.Prepare(t.Context(), Input{TenantID: preparationID(t), SpaceID: preparationID(t), StartsAt: now.Add(time.Hour)})
			if err == nil || repository.called {
				t.Fatalf("policy result = %v, persisted = %t", err, repository.called)
			}
		})
	}
}

func TestPreparationPreservesRepositoryConflict(t *testing.T) {
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	repository := &preparationRepositoryStub{err: ErrConflict}
	service := NewService(repository, preparationSpaceStub{space: spaces.Space{RecordingPolicy: artifactpolicy.RecordingManual}})
	service.now = func() time.Time { return now }
	_, err := service.Prepare(t.Context(), Input{TenantID: preparationID(t), SpaceID: preparationID(t), StartsAt: now})
	if !errors.Is(err, ErrConflict) || !repository.called {
		t.Fatalf("result = %v, called = %t", err, repository.called)
	}
}

type preparationRepositoryStub struct {
	Repository
	called bool
	err    error
}

func (r *preparationRepositoryStub) Prepare(context.Context, Input, time.Time) (Preparation, error) {
	r.called = true
	return Preparation{}, r.err
}

type preparationSpaceStub struct {
	space spaces.Space
	err   error
}

func (s preparationSpaceStub) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return s.space, s.err
}
func preparationID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
