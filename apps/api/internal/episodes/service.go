package episodes

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type Repository interface {
	GetEpisodeAttendance(context.Context, utilities.ID, utilities.ID, utilities.ID) ([]AttendanceParticipant, error)
	ListSpaceLiveEpisodes(context.Context, utilities.ID, []utilities.ID) ([]SpaceLiveEpisode, error)
	ListSpaceActivity(context.Context, utilities.ID, []utilities.ID) ([]SpaceActivity, error)
	CreateEpisode(context.Context, CreateEpisodeInput) (Episode, error)
	GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (Episode, error)
	ListEpisodes(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (EpisodeList, error)
	AdmitParticipant(context.Context, AdmitParticipantInput) (Admission, error)
	RequestParticipantRemoval(context.Context, RequestParticipantRemovalInput) (Removal, error)
	RequestEpisodeEnd(context.Context, RequestEpisodeEndInput) (EndRequest, error)
	SetDeadline(context.Context, SetDeadlineInput) (ControlRequest, error)
}

type DeadlineSchedulerRepository interface {
	EnqueueDueEpisodeDeadlines(context.Context, int32) (DeadlineCycle, error)
}

// CommitObserver receives already-committed Episode facts. Implementations must
// enqueue without blocking and own their recovery path; product behavior never
// depends on diagnostic observation.
type CommitObserver interface {
	EpisodeCommitted(Episode)
}

type Service struct {
	repository Repository
	observer   CommitObserver
}

func NewService(repository Repository) Service {
	return Service{repository: repository}
}

func (s Service) JoinPublic(ctx context.Context, input PublicJoinInput) (PublicJoinResult, error) {
	if err := preparePublicJoinInput(&input); err != nil {
		return PublicJoinResult{}, err
	}
	repository, ok := s.repository.(PublicJoinRepository)
	if !ok {
		return PublicJoinResult{}, ErrSynchronousCommit
	}
	result, err := repository.JoinPublic(ctx, input)
	if err != nil {
		return PublicJoinResult{}, err
	}
	if result.EpisodeCreated {
		s.observeEpisodeCommitted(result.Episode)
	}
	return result, nil
}

func (s Service) FindPublic(ctx context.Context, input PublicAccessInput) (PublicJoinResult, error) {
	if err := preparePublicAccessInput(&input); err != nil {
		return PublicJoinResult{}, err
	}
	repository, ok := s.repository.(PublicJoinRepository)
	if !ok {
		return PublicJoinResult{}, ErrSynchronousCommit
	}
	return repository.FindPublic(ctx, input)
}

func (s Service) LeavePublic(ctx context.Context, input PublicLeaveInput) (PublicLeaveResult, error) {
	if err := preparePublicLeaveInput(&input); err != nil {
		return PublicLeaveResult{}, err
	}
	repository, ok := s.repository.(PublicJoinRepository)
	if !ok {
		return PublicLeaveResult{}, ErrSynchronousCommit
	}
	return repository.LeavePublic(ctx, input)
}

func (s Service) WaitPublicParticipantReady(ctx context.Context, key PublicParticipantKey) (PublicJoinResult, error) {
	if err := validatePublicParticipantKey(key); err != nil {
		return PublicJoinResult{}, err
	}
	repository, ok := s.repository.(PublicJoinRepository)
	if !ok {
		return PublicJoinResult{}, ErrSynchronousCommit
	}
	return repository.WaitPublicParticipantReady(ctx, key)
}

func (s Service) WithCommitObserver(observer CommitObserver) Service {
	s.observer = observer
	return s
}

func (s Service) CreateEpisode(ctx context.Context, input CreateEpisodeInput) (Episode, error) {
	if input.ID.IsZero() {
		id, err := utilities.NewID()
		if err != nil {
			return Episode{}, err
		}
		input.ID = id
	}
	if err := prepareCreateEpisodeInput(&input); err != nil {
		return Episode{}, err
	}
	episode, err := s.repository.CreateEpisode(ctx, input)
	if err != nil {
		return Episode{}, err
	}
	s.observeEpisodeCommitted(episode)
	return episode, nil
}

func (s Service) observeEpisodeCommitted(episode Episode) {
	if s.observer == nil {
		return
	}
	defer func() { _ = recover() }()
	s.observer.EpisodeCommitted(episode)
}

func (s Service) GetEpisode(ctx context.Context, tenantID, spaceID, episodeID utilities.ID) (Episode, error) {
	if err := validateTenantSpaceEpisodeIDs(tenantID, spaceID, episodeID); err != nil {
		return Episode{}, err
	}
	return s.repository.GetEpisode(ctx, tenantID, spaceID, episodeID)
}

func (s Service) ListEpisodes(ctx context.Context, tenantID, spaceID utilities.ID, page pagination.PageRequest) (EpisodeList, error) {
	if tenantID.IsZero() {
		return EpisodeList{}, ErrInvalidTenantID
	}
	if spaceID.IsZero() {
		return EpisodeList{}, ErrInvalidSpaceID
	}
	return s.repository.ListEpisodes(ctx, tenantID, spaceID, page)
}

func (s Service) AdmitParticipant(ctx context.Context, input AdmitParticipantInput) (Admission, error) {
	if input.ParticipantID.IsZero() {
		id, err := utilities.NewID()
		if err != nil {
			return Admission{}, err
		}
		input.ParticipantID = id
	}
	if err := prepareAdmissionInput(&input); err != nil {
		return Admission{}, err
	}
	return s.repository.AdmitParticipant(ctx, input)
}

func (s Service) RequestParticipantRemoval(ctx context.Context, input RequestParticipantRemovalInput) (Removal, error) {
	if err := prepareParticipantRemovalInput(&input); err != nil {
		return Removal{}, err
	}
	return s.repository.RequestParticipantRemoval(ctx, input)
}

func (s Service) RequestEpisodeEnd(ctx context.Context, input RequestEpisodeEndInput) (EndRequest, error) {
	if err := prepareEpisodeEndInput(&input); err != nil {
		return EndRequest{}, err
	}
	return s.repository.RequestEpisodeEnd(ctx, input)
}

func (s Service) SetDeadline(ctx context.Context, input SetDeadlineInput) (ControlRequest, error) {
	if err := prepareSetDeadlineInput(&input); err != nil {
		return ControlRequest{}, err
	}
	return s.repository.SetDeadline(ctx, input)
}
