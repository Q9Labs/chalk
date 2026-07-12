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

	IntentParticipantJoined = "participant_joined"
	IntentParticipantLeft   = "participant_left"
	IntentSessionEnded      = "session_ended"
	IntentStatusPending     = "pending"

	LifecycleReservationBytes           int64 = 16 * 1024
	ParticipantSnapshotReservationBytes int64 = 2 * 1024
	MaximumIntentPayloadBytes                 = 16 * 1024
	MaximumParticipantNameBytes               = 256
	MaximumActiveParticipantSessions    int64 = 500
	MaximumSnapshotBytes                int64 = 1024 * 1024
)

type Repository interface {
	CreateSession(context.Context, CreateSessionInput) (Session, error)
	AdmitParticipant(context.Context, AdmitParticipantInput) (Admission, error)
	RequestParticipantRemoval(context.Context, RequestParticipantRemovalInput) (Removal, error)
	RequestSessionEnd(context.Context, RequestSessionEndInput) (EndRequest, error)
}

type Service struct {
	repository Repository
}

type InitialControlState struct {
	FoldedState   json.RawMessage
	Digest        [32]byte
	SchemaVersion int32
	// SnapshotBytes comes from the canonical v2 encoder. The lifecycle service
	// preserves this value because canonicalization does not belong in Go yet.
	SnapshotBytes int64
}

type CreateSessionInput struct {
	ID              utilities.ID
	TenantID        utilities.ID
	RoomID          utilities.ID
	Metadata        json.RawMessage
	CreatedByUserID utilities.ID
	StartedAt       *time.Time
	InitialControl  InitialControlState
	Request         Request
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
	Capabilities  []string
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
	Session     Session
	Participant Participant
	Intent      Intent
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
