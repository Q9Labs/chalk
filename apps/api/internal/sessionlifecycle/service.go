package sessionlifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidTenantID                    = errors.New("invalid lifecycle tenant id")
	ErrInvalidRoomID                      = errors.New("invalid lifecycle room id")
	ErrInvalidSessionID                   = errors.New("invalid lifecycle session id")
	ErrInvalidParticipantID               = errors.New("invalid lifecycle participant id")
	ErrInvalidParticipantGeneration       = errors.New("invalid lifecycle participant generation")
	ErrInvalidParticipantName             = errors.New("invalid lifecycle participant name")
	ErrInvalidAdmissionPolicy             = errors.New("invalid lifecycle admission policy")
	ErrInvalidHostExitPolicy              = errors.New("invalid lifecycle host exit policy")
	ErrInvalidRoleCapabilities            = errors.New("invalid lifecycle role capabilities")
	ErrInvalidMaximumDuration             = errors.New("invalid lifecycle maximum duration")
	ErrInvalidMaximumDurationCeiling      = errors.New("invalid lifecycle maximum duration ceiling")
	ErrInvalidDeadline                    = errors.New("invalid lifecycle deadline")
	ErrDeadlineExceedsCeiling             = errors.New("lifecycle deadline exceeds the server ceiling")
	ErrInvalidInitialRole                 = errors.New("invalid lifecycle initial role")
	ErrInvalidEligibleRoles               = errors.New("invalid lifecycle eligible roles")
	ErrAdmissionClosed                    = errors.New("lifecycle admission is closed")
	ErrInvalidInitialControlState         = errors.New("invalid initial control state")
	ErrInvalidInitialControlSchemaVersion = errors.New("invalid initial control schema version")
	ErrInvalidInitialControlSnapshotBytes = errors.New("invalid initial control snapshot bytes")
	ErrInvalidRequestKey                  = errors.New("invalid lifecycle request key")
	ErrInvalidIntentPayload               = errors.New("invalid lifecycle intent payload")
	ErrRoomNotFound                       = errors.New("lifecycle room not found")
	ErrSessionNotFound                    = errors.New("lifecycle session not found")
	ErrSessionNotActive                   = errors.New("lifecycle session is not active")
	ErrParticipantNotFound                = errors.New("lifecycle participant not found")
	ErrParticipantNotActive               = errors.New("lifecycle participant is not active")
	ErrParticipantGenerationMismatch      = errors.New("lifecycle participant generation mismatch")
	ErrHostRecoveryTargetIneligible       = errors.New("lifecycle host recovery target is ineligible")
	ErrDeadlineChangePending              = errors.New("lifecycle deadline change is already pending")
	ErrSessionControlBusy                 = errors.New("lifecycle session control is busy")
	ErrIdempotencyConflict                = errors.New("lifecycle request key conflicts with original request")
	ErrCapacityExceeded                   = errors.New("lifecycle capacity exceeded")
	ErrSessionAlreadyExists               = errors.New("lifecycle session already exists")
	ErrSynchronousCommit                  = errors.New("synchronous commit is not enabled for lifecycle transaction")
)

const (
	SessionStatusActive = "active"
	SessionStatusEnding = "ending"
	SessionStatusEnded  = "ended"

	ParticipantStatusJoining = "joining"
	ParticipantStatusActive  = "active"
	ParticipantStatusLeaving = "leaving"
	ParticipantStatusLeft    = "left"

	IntentParticipantJoined         = "participant_joined"
	IntentAdmissionRequested        = "admission_requested"
	IntentStatusPending             = "pending"
	OperationTenantTransferHost     = "tenant_transfer_host"
	OperationTenantSetDeadline      = "tenant_set_deadline"
	OperationTenantEndSession       = "tenant_end_session"
	OperationMaximumDurationExpired = "maximum_duration_expired"
	OperationRemoveParticipant      = "remove_participant"

	LifecycleReservationBytes           int64 = 16 * 1024
	ParticipantSnapshotReservationBytes int64 = 2 * 1024
	MaximumIntentPayloadBytes                 = 16 * 1024
	MaximumParticipantNameBytes               = 256
	MaximumActiveParticipantSessions    int64 = 500
	MaximumSnapshotBytes                int64 = 1024 * 1024
	AdmissionRequestLifetime                  = 5 * time.Minute
	MinimumSessionDurationSeconds       int32 = 60
	MaximumSessionDurationSeconds       int32 = 7 * 24 * 60 * 60
)

type Repository interface {
	CreateSession(context.Context, CreateSessionInput) (Session, error)
	AdmitParticipant(context.Context, AdmitParticipantInput) (Admission, error)
	RequestParticipantRemoval(context.Context, RequestParticipantRemovalInput) (Removal, error)
	RequestSessionEnd(context.Context, RequestSessionEndInput) (EndRequest, error)
}

type ControlRepository interface {
	TransferHost(context.Context, TransferHostInput) (ControlRequest, error)
	SetDeadline(context.Context, SetDeadlineInput) (ControlRequest, error)
}

type Service struct {
	repository Repository
}

type InitialControlState struct {
	FoldedState   json.RawMessage
	Digest        [32]byte
	SchemaVersion int32
	SnapshotBytes int64
}

type CreateSessionInput struct {
	ID                            utilities.ID
	TenantID                      utilities.ID
	RoomID                        utilities.ID
	Metadata                      json.RawMessage
	CreatedByUserID               utilities.ID
	StartedAt                     *time.Time
	AdmissionPolicy               string
	HostExitPolicy                string
	RoleCapabilities              map[string][]string
	MaximumDurationSeconds        int32
	MaximumDurationCeilingSeconds int32
	DeadlineAt                    time.Time
	InitialControl                InitialControlState
	Request                       Request
}

type Request struct {
	Key string
	// Fingerprint is derived by the service from the normalized semantic input.
	// It is exported for repository adapters and never accepted from HTTP.
	Fingerprint [32]byte
	payload     json.RawMessage
}

// Payload returns the lifecycle payload generated from the semantic request.
// The caller supplies the request key and fingerprint, not event-shaped JSON.
func (r Request) Payload() json.RawMessage {
	payload := make(json.RawMessage, len(r.payload))
	copy(payload, r.payload)
	return payload
}

type AdmitParticipantInput struct {
	TenantID      utilities.ID
	RoomID        utilities.ID
	SessionID     utilities.ID
	ParticipantID utilities.ID
	Name          string
	Metadata      json.RawMessage
	InitialRole   string
	EligibleRoles []string
	UserID        utilities.ID
	Request       Request
}

type RequestParticipantRemovalInput struct {
	TenantID              utilities.ID
	RoomID                utilities.ID
	SessionID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Request               Request
}

type RequestSessionEndInput struct {
	TenantID  utilities.ID
	RoomID    utilities.ID
	SessionID utilities.ID
	Request   Request
}

type TransferHostInput struct {
	TenantID              utilities.ID
	RoomID                utilities.ID
	SessionID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Request               Request
}

type SetDeadlineInput struct {
	TenantID  utilities.ID
	RoomID    utilities.ID
	SessionID utilities.ID
	Deadline  time.Time
	Request   Request
}

type Session struct {
	ID        utilities.ID
	TenantID  utilities.ID
	RoomID    utilities.ID
	Status    string
	CreatedAt time.Time
}

type Participant struct {
	ID         utilities.ID
	TenantID   utilities.ID
	RoomID     utilities.ID
	SessionID  utilities.ID
	Generation int64
	Status     string
}

type Intent struct {
	ID                    utilities.ID
	TenantID              utilities.ID
	RoomID                utilities.ID
	SessionID             utilities.ID
	RequestKey            string
	IntentName            string
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Status                string
	CreatedAt             time.Time
}

type Admission struct {
	Session          Session
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
	Session     Session
	Participant Participant
	Intent      Intent
}

type EndRequest struct {
	Session Session
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
	Session   Session
	Operation ExternalOperation
}

func NewService(repository Repository) Service {
	return Service{repository: repository}
}

func (s Service) CreateSession(ctx context.Context, input CreateSessionInput) (Session, error) {
	if input.ID.IsZero() {
		id, err := utilities.NewID()
		if err != nil {
			return Session{}, err
		}
		input.ID = id
	}
	if err := prepareCreateSessionInput(&input); err != nil {
		return Session{}, err
	}

	return s.repository.CreateSession(ctx, input)
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

func (s Service) RequestSessionEnd(ctx context.Context, input RequestSessionEndInput) (EndRequest, error) {
	if err := prepareSessionEndInput(&input); err != nil {
		return EndRequest{}, err
	}

	return s.repository.RequestSessionEnd(ctx, input)
}

func (s Service) TransferHost(ctx context.Context, input TransferHostInput) (ControlRequest, error) {
	if err := prepareTransferHostInput(&input); err != nil {
		return ControlRequest{}, err
	}

	repository, ok := s.repository.(ControlRepository)
	if !ok {
		return ControlRequest{}, errors.New("tenant control repository is unavailable")
	}
	return repository.TransferHost(ctx, input)
}

func (s Service) SetDeadline(ctx context.Context, input SetDeadlineInput) (ControlRequest, error) {
	if err := prepareSetDeadlineInput(&input); err != nil {
		return ControlRequest{}, err
	}

	repository, ok := s.repository.(ControlRepository)
	if !ok {
		return ControlRequest{}, errors.New("tenant control repository is unavailable")
	}
	return repository.SetDeadline(ctx, input)
}
