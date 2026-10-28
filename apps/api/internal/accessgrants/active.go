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
	CheckParticipantMediaConnection(context.Context, synctokens.SubjectKey, int64, string) error
	ReplaceParticipantMediaConnection(context.Context, synctokens.SubjectKey, int64, string, string) error
	ReserveParticipantMediaRefresh(context.Context, synctokens.SubjectKey, int64, string, string, [32]byte) error
	LoadParticipantMediaRefresh(context.Context, synctokens.SubjectKey, int64, [32]byte) (*StoredRefreshReplay, error)
	CompleteParticipantMediaRefresh(context.Context, synctokens.SubjectKey, int64, string, string, RefreshReplay) error
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

// CheckParticipantMediaConnection rejects a credential whose connection was replaced.
func (a ActiveAuthorizer) CheckParticipantMediaConnection(ctx context.Context, subject Subject) error {
	return a.repository.CheckParticipantMediaConnection(ctx, synctokens.SubjectKey{
		TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID,
	}, subject.ParticipantGeneration, subject.CloudflareConnectionID)
}

// ReplaceParticipantMediaConnection fences concurrent refreshes of the same credential.
func (a ActiveAuthorizer) ReplaceParticipantMediaConnection(ctx context.Context, previous, next Subject) error {
	return a.repository.ReplaceParticipantMediaConnection(ctx, synctokens.SubjectKey{
		TenantID: previous.TenantID, SpaceID: previous.SpaceID, EpisodeID: previous.EpisodeID, ParticipantID: previous.ParticipantID,
	}, previous.ParticipantGeneration, previous.CloudflareConnectionID, next.CloudflareConnectionID)
}

func (a ActiveAuthorizer) ReserveParticipantMediaRefresh(ctx context.Context, previous, reservation Subject, requestHash [32]byte) error {
	return a.repository.ReserveParticipantMediaRefresh(ctx, synctokens.SubjectKey{
		TenantID: previous.TenantID, SpaceID: previous.SpaceID, EpisodeID: previous.EpisodeID, ParticipantID: previous.ParticipantID,
	}, previous.ParticipantGeneration, previous.CloudflareConnectionID, reservation.CloudflareConnectionID, requestHash)
}

func (a ActiveAuthorizer) LoadParticipantMediaRefresh(ctx context.Context, subject Subject, requestHash [32]byte) (*StoredRefreshReplay, error) {
	return a.repository.LoadParticipantMediaRefresh(ctx, synctokens.SubjectKey{
		TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID,
	}, subject.ParticipantGeneration, requestHash)
}

func (a ActiveAuthorizer) CompleteParticipantMediaRefresh(ctx context.Context, previous, next Subject, replay RefreshReplay) error {
	return a.repository.CompleteParticipantMediaRefresh(ctx, synctokens.SubjectKey{
		TenantID: previous.TenantID, SpaceID: previous.SpaceID, EpisodeID: previous.EpisodeID, ParticipantID: previous.ParticipantID,
	}, previous.ParticipantGeneration, previous.CloudflareConnectionID, next.CloudflareConnectionID, replay)
}
