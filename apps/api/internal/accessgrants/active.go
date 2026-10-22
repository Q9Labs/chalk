package accessgrants

import (
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/synctokens"
)

// ActiveAuthorizer binds a verified media subject to the authoritative live
// participant generation already used by Sync token refresh.
type ActiveRepository interface {
	synctokens.SubjectRepository
	SetParticipantMediaConnection(context.Context, synctokens.SubjectKey, int64, string) error
}

type ActiveAuthorizer struct {
	repository ActiveRepository
}

func NewActiveAuthorizer(repository ActiveRepository) ActiveAuthorizer {
	return ActiveAuthorizer{repository: repository}
}

func (a ActiveAuthorizer) AuthorizeActiveParticipant(ctx context.Context, subject Subject) (bool, error) {
	if a.repository == nil || !validSubject(subject) {
		return false, ErrInvalidSubject
	}
	return a.AuthorizeActiveParticipantGeneration(ctx, synctokens.SubjectKey{
		TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID,
		ParticipantID: subject.ParticipantID,
	}, subject.ParticipantGeneration)
}

func (a ActiveAuthorizer) AuthorizeActiveParticipantGeneration(ctx context.Context, key synctokens.SubjectKey, generation int64) (bool, error) {
	if a.repository == nil || key.TenantID.IsZero() || key.SpaceID.IsZero() || key.EpisodeID.IsZero() || key.ParticipantID.IsZero() || generation <= 0 {
		return false, ErrInvalidSubject
	}
	current, err := a.repository.GetSyncTokenSubject(ctx, key)
	if errors.Is(err, synctokens.ErrSubjectNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if current.ParticipantGeneration != generation {
		return false, ErrGenerationMismatch
	}
	return current.TenantID == key.TenantID &&
		current.SpaceID == key.SpaceID &&
		current.EpisodeID == key.EpisodeID &&
		current.ParticipantID == key.ParticipantID &&
		current.ParticipantGeneration == generation, nil
}

// BindParticipantMediaConnection records the connection before returning its grant.
// Old publications must disappear even when the replacement starts muted.
func (a ActiveAuthorizer) BindParticipantMediaConnection(ctx context.Context, subject Subject) error {
	if a.repository == nil || !validSubject(subject) {
		return ErrInvalidSubject
	}
	return a.repository.SetParticipantMediaConnection(ctx, synctokens.SubjectKey{
		TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID,
	}, subject.ParticipantGeneration, subject.CloudflareConnectionID)
}
