package episodes

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidTenantID                    = errors.New("invalid episode tenant id")
	ErrInvalidSpaceID                     = errors.New("invalid episode space id")
	ErrInvalidEpisodeID                   = errors.New("invalid episode id")
	ErrInvalidParticipantID               = errors.New("invalid episode participant id")
	ErrInvalidParticipantGeneration       = errors.New("invalid episode participant generation")
	ErrInvalidParticipantName             = errors.New("invalid episode participant name")
	ErrInvalidAdmissionPolicy             = errors.New("invalid episode admission policy")
	ErrInvalidRole                        = errors.New("invalid episode participant role")
	ErrInvalidRoleCapabilities            = errors.New("invalid episode role capabilities")
	ErrInvalidConfigSnapshot              = errors.New("invalid episode config snapshot")
	ErrInvalidMaximumDuration             = errors.New("invalid episode maximum duration")
	ErrInvalidMaximumDurationCeiling      = errors.New("invalid episode maximum duration ceiling")
	ErrInvalidDeadline                    = errors.New("invalid episode deadline")
	ErrDeadlineExceedsCeiling             = errors.New("episode deadline exceeds the server ceiling")
	ErrAdmissionClosed                    = errors.New("episode admission is closed")
	ErrInvalidInitialControlState         = errors.New("invalid initial episode control state")
	ErrInvalidInitialControlSchemaVersion = errors.New("invalid initial episode control schema version")
	ErrInvalidInitialControlSnapshotBytes = errors.New("invalid initial episode control snapshot bytes")
	ErrInvalidRequestKey                  = errors.New("invalid episode request key")
	ErrInvalidIntentPayload               = errors.New("invalid episode intent payload")
	ErrSpaceNotFound                      = errors.New("episode space not found")
	ErrEpisodeNotFound                    = errors.New("episode not found")
	ErrEpisodeNotActive                   = errors.New("episode is not active")
	ErrParticipantNotFound                = errors.New("episode participant not found")
	ErrParticipantNotActive               = errors.New("episode participant is not active")
	ErrParticipantGenerationMismatch      = errors.New("episode participant generation mismatch")
	ErrDeadlineChangePending              = errors.New("episode deadline change is already pending")
	ErrEpisodeControlBusy                 = errors.New("episode control is busy")
	ErrIdempotencyConflict                = errors.New("episode request key conflicts with original request")
	ErrCapacityExceeded                   = errors.New("episode capacity exceeded")
	ErrEpisodeAlreadyExists               = errors.New("episode already exists")
	ErrSynchronousCommit                  = errors.New("synchronous commit is not enabled for episode transaction")
	ErrInvalidAccountID                   = errors.New("invalid dashboard account id")
	ErrInvalidSpaceSlug                   = errors.New("invalid episode space slug")
)

const (
	EpisodeStatusActive = "active"
	EpisodeStatusEnding = "ending"
	EpisodeStatusEnded  = "ended"

	ParticipantStatusJoining = "joining"
	ParticipantStatusActive  = "active"
	ParticipantStatusLeaving = "leaving"
	ParticipantStatusLeft    = "left"

	IntentParticipantJoined         = "participant_joined"
	IntentAdmissionRequested        = "admission_requested"
	IntentStatusPending             = "pending"
	OperationTenantSetDeadline      = "tenant_set_deadline"
	OperationTenantEndEpisode       = "tenant_end_episode"
	OperationMaximumDurationExpired = "maximum_duration_expired"
	OperationRemoveParticipant      = "remove_participant"

	LifecycleReservationBytes           int64 = 16 * 1024
	ParticipantSnapshotReservationBytes int64 = 2 * 1024
	MaximumIntentPayloadBytes                 = 16 * 1024
	MaximumParticipantNameBytes               = 256
	MaximumActiveParticipants           int64 = 500
	MaximumSnapshotBytes                int64 = 1024 * 1024
	AdmissionRequestLifetime                  = 5 * time.Minute
	MinimumEpisodeDurationSeconds       int32 = 60
	MaximumEpisodeDurationSeconds       int32 = 7 * 24 * 60 * 60
)

// Capability names are a closed wire vocabulary. Roles are customer-defined
// names, so only their capability bundles are validated here.
var capabilityOrder = []string{
	"publishAudio", "publishVideo", "publishScreen", "subscribe", "raiseHand", "renameSelf",
	"sendChat", "sendReaction", "drawWhiteboard", "manageWhiteboard", "manageAdmission", "assignRoles",
	"muteOthers", "stopVideoOthers", "stopScreenOthers", "requestMediaOthers", "removeParticipant",
	"manageRecording", "startEpisode", "extendEpisode", "endEpisode", "manageMembers", "clearSpaceContent",
}

var validCapabilities = func() map[string]struct{} {
	result := make(map[string]struct{}, len(capabilityOrder))
	for _, capability := range capabilityOrder {
		result[capability] = struct{}{}
	}
	return result
}()

type Repository interface {
	CreateEpisode(context.Context, CreateEpisodeInput) (Episode, error)
	GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (Episode, error)
	ListEpisodes(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (EpisodeList, error)
	AdmitParticipant(context.Context, AdmitParticipantInput) (Admission, error)
	RequestParticipantRemoval(context.Context, RequestParticipantRemovalInput) (Removal, error)
	RequestEpisodeEnd(context.Context, RequestEpisodeEndInput) (EndRequest, error)
	SetDeadline(context.Context, SetDeadlineInput) (ControlRequest, error)
}

// SelfJoinRepository owns the Dashboard Account boundary. It deliberately
// sits beside Repository so legacy lifecycle callers keep their existing
// seams while the account-bound join can resolve a Space slug, live Episode,
// and stable account Participant in one transaction.
type SelfJoinRepository interface {
	JoinSelf(context.Context, SelfJoinInput) (SelfJoinResult, error)
	FindSelf(context.Context, SelfAccessInput) (SelfJoinResult, error)
	LeaveSelf(context.Context, SelfLeaveInput) (SelfLeaveResult, error)
}

type DeadlineSchedulerRepository interface {
	EnqueueDueEpisodeDeadlines(context.Context, int32) (int, error)
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

type SelfJoinInput struct {
	TenantID    utilities.ID
	AccountID   utilities.ID
	SpaceSlug   string
	DisplayName string
	Request     Request
}

type SelfAccessInput struct {
	TenantID  utilities.ID
	AccountID utilities.ID
	SpaceSlug string
}

type SelfLeaveInput struct {
	TenantID              utilities.ID
	AccountID             utilities.ID
	SpaceSlug             string
	ParticipantGeneration int64
	Request               Request
}

type SelfJoinResult struct {
	Episode        Episode
	Participant    Participant
	Intent         Intent
	EpisodeCreated bool
}

type SelfLeaveResult struct {
	Episode     Episode
	Participant Participant
	Removed     bool
}

type EpisodeList struct {
	Episodes []Episode
	Page     pagination.Page
}

type InitialControlState struct {
	FoldedState   json.RawMessage
	Digest        [32]byte
	SchemaVersion int32
	SnapshotBytes int64
}

// EpisodeConfigSnapshot is the immutable policy captured when an Episode
// starts. Role names are customer-defined and each capability list is frozen.
type EpisodeConfigSnapshot struct {
	AdmissionPolicy               json.RawMessage     `json:"admission_policy"`
	Roles                         map[string][]string `json:"roles"`
	DefaultEpisodeDurationSeconds int32               `json:"default_episode_duration_seconds"`
	MaximumEpisodeDurationSeconds int32               `json:"maximum_episode_duration_seconds"`
	LingerWindowSeconds           int32               `json:"linger_window_seconds"`
}

type CreateEpisodeInput struct {
	ID                            utilities.ID
	TenantID                      utilities.ID
	SpaceID                       utilities.ID
	Metadata                      json.RawMessage
	CreatedByUserID               utilities.ID
	StartedAt                     *time.Time
	ConfigSnapshot                json.RawMessage
	MaximumDurationSeconds        int32
	MaximumDurationCeilingSeconds int32
	DeadlineAt                    time.Time
	InitialControl                InitialControlState
	Request                       Request
}

type Request struct {
	Key         string
	Fingerprint [32]byte
	payload     json.RawMessage
}

// Payload returns the lifecycle payload generated from the semantic request.
func (r Request) Payload() json.RawMessage {
	payload := make(json.RawMessage, len(r.payload))
	copy(payload, r.payload)
	return payload
}

type AdmitParticipantInput struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
	Name          string
	Metadata      json.RawMessage
	Role          string
	IdentityID    utilities.ID
	Request       Request
}

type RequestParticipantRemovalInput struct {
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Request               Request
}

type RequestEpisodeEndInput struct {
	TenantID  utilities.ID
	SpaceID   utilities.ID
	EpisodeID utilities.ID
	Request   Request
}

type SetDeadlineInput struct {
	TenantID  utilities.ID
	SpaceID   utilities.ID
	EpisodeID utilities.ID
	Deadline  time.Time
	Request   Request
}

type Episode struct {
	ID                 utilities.ID
	TenantID           utilities.ID
	SpaceID            utilities.ID
	Status             string
	Metadata           json.RawMessage
	ConfigSnapshot     json.RawMessage
	EndReason          *string
	StartedAt          time.Time
	EndedAt            time.Time
	DeadlineAt         time.Time
	DeadlineGeneration int64
	UpdatedAt          time.Time
	CreatedAt          time.Time
}

type Participant struct {
	ID           utilities.ID
	TenantID     utilities.ID
	SpaceID      utilities.ID
	EpisodeID    utilities.ID
	AccountID    utilities.ID
	IdentityID   utilities.ID
	Role         string
	Capabilities []string
	Generation   int64
	Status       string
}

type Intent struct {
	ID                    utilities.ID
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	RequestKey            string
	IntentName            string
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Status                string
	CreatedAt             time.Time
}

type Admission struct {
	Episode          Episode
	Participant      Participant
	Intent           Intent
	JoinIntent       Intent
	AdmissionRequest *AdmissionRequest
}

type AdmissionRequest struct {
	ID        utilities.ID
	Status    string
	ExpiresAt time.Time
}

type Removal struct {
	Episode     Episode
	Participant Participant
	Intent      Intent
}

type EndRequest struct {
	Episode Episode
	Intent  Intent
}

type ExternalOperation struct {
	ID                  utilities.ID
	RequestKey          string
	OperationName       string
	TargetParticipantID utilities.ID
	TargetGeneration    int64
	DeadlineGeneration  int64
	Status              string
	CreatedAt           time.Time
}

type ControlRequest struct {
	Episode   Episode
	Operation ExternalOperation
}

func NewService(repository Repository) Service {
	return Service{repository: repository}
}

func (s Service) JoinSelf(ctx context.Context, input SelfJoinInput) (SelfJoinResult, error) {
	if err := prepareSelfJoinInput(&input); err != nil {
		return SelfJoinResult{}, err
	}
	repository, ok := s.repository.(SelfJoinRepository)
	if !ok {
		return SelfJoinResult{}, ErrSynchronousCommit
	}
	result, err := repository.JoinSelf(ctx, input)
	if err != nil {
		return SelfJoinResult{}, err
	}
	if result.EpisodeCreated {
		s.observeEpisodeCommitted(result.Episode)
	}
	return result, nil
}

func (s Service) FindSelf(ctx context.Context, input SelfAccessInput) (SelfJoinResult, error) {
	if err := prepareSelfAccessInput(&input); err != nil {
		return SelfJoinResult{}, err
	}
	repository, ok := s.repository.(SelfJoinRepository)
	if !ok {
		return SelfJoinResult{}, ErrSynchronousCommit
	}
	return repository.FindSelf(ctx, input)
}

func (s Service) LeaveSelf(ctx context.Context, input SelfLeaveInput) (SelfLeaveResult, error) {
	if err := prepareSelfLeaveInput(&input); err != nil {
		return SelfLeaveResult{}, err
	}
	repository, ok := s.repository.(SelfJoinRepository)
	if !ok {
		return SelfLeaveResult{}, ErrSynchronousCommit
	}
	return repository.LeaveSelf(ctx, input)
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
