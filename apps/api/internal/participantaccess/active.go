package participantaccess

import (
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/synctokens"
)

// ActiveAuthorizer binds a verified media subject to the authoritative live
// participant generation already used by Sync token refresh.
type ActiveAuthorizer struct {
	repository synctokens.SubjectRepository
}

func NewActiveAuthorizer(repository synctokens.SubjectRepository) ActiveAuthorizer {
	return ActiveAuthorizer{repository: repository}
}

func (a ActiveAuthorizer) AuthorizeActiveParticipant(ctx context.Context, subject Subject) (bool, error) {
	if a.repository == nil || !validSubject(subject) {
		return false, ErrInvalidSubject
	}
	return a.AuthorizeActiveParticipantGeneration(ctx, synctokens.SubjectKey{
		TenantID: subject.TenantID, RoomID: subject.RoomID, SessionID: subject.SessionID,
		ParticipantID: subject.ParticipantSessionID,
	}, subject.ParticipantGeneration)
}

func (a ActiveAuthorizer) AuthorizeActiveParticipantGeneration(ctx context.Context, key synctokens.SubjectKey, generation int64) (bool, error) {
	if a.repository == nil || key.TenantID.IsZero() || key.RoomID.IsZero() || key.SessionID.IsZero() || key.ParticipantID.IsZero() || generation <= 0 {
		return false, ErrInvalidSubject
	}
	current, err := a.repository.GetSyncTokenSubject(ctx, key)
	if errors.Is(err, synctokens.ErrSubjectNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return current.TenantID == key.TenantID &&
		current.RoomID == key.RoomID &&
		current.SessionID == key.SessionID &&
		current.ParticipantID == key.ParticipantID &&
		current.ParticipantGeneration == generation, nil
}
