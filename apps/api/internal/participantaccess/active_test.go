package participantaccess_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/participantaccess"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
)

type subjectRepositoryFunc func(context.Context, synctokens.SubjectKey) (synctokens.Input, error)

func (f subjectRepositoryFunc) GetSyncTokenSubject(ctx context.Context, key synctokens.SubjectKey) (synctokens.Input, error) {
	return f(ctx, key)
}

func TestActiveAuthorizerRequiresExactLiveGeneration(t *testing.T) {
	subject := testSubject(t)
	activeGeneration := subject.ParticipantGeneration
	authorizer := participantaccess.NewActiveAuthorizer(subjectRepositoryFunc(func(_ context.Context, key synctokens.SubjectKey) (synctokens.Input, error) {
		return synctokens.Input{
			TenantID: key.TenantID, RoomID: key.RoomID, SessionID: key.SessionID,
			ParticipantID: key.ParticipantID, ParticipantGeneration: activeGeneration,
		}, nil
	}))
	active, err := authorizer.AuthorizeActiveParticipant(context.Background(), subject)
	if err != nil || !active {
		t.Fatalf("active/error = %v/%v", active, err)
	}

	subject.ParticipantGeneration++
	active, err = authorizer.AuthorizeActiveParticipant(context.Background(), subject)
	if err != nil || active {
		t.Fatalf("stale active/error = %v/%v", active, err)
	}
}

func TestActiveAuthorizerMapsMissingSubjectAndPreservesDependencyFailure(t *testing.T) {
	subject := testSubject(t)
	missing := participantaccess.NewActiveAuthorizer(subjectRepositoryFunc(func(context.Context, synctokens.SubjectKey) (synctokens.Input, error) {
		return synctokens.Input{}, synctokens.ErrSubjectNotFound
	}))
	active, err := missing.AuthorizeActiveParticipant(context.Background(), subject)
	if err != nil || active {
		t.Fatalf("missing active/error = %v/%v", active, err)
	}

	want := errors.New("database unavailable")
	failing := participantaccess.NewActiveAuthorizer(subjectRepositoryFunc(func(context.Context, synctokens.SubjectKey) (synctokens.Input, error) {
		return synctokens.Input{}, want
	}))
	if _, err := failing.AuthorizeActiveParticipant(context.Background(), subject); !errors.Is(err, want) {
		t.Fatalf("error = %v", err)
	}
}
