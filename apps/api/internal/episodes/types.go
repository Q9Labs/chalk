package episodes

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
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
	ErrInvalidIdentityMode                = errors.New("invalid episode participant identity mode")
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
	ErrPublicParticipantNotReady          = errors.New("public episode participant is not ready")
	ErrDeadlineChangePending              = errors.New("episode deadline change is already pending")
	ErrEpisodeControlBusy                 = errors.New("episode control is busy")
	ErrIdempotencyConflict                = errors.New("episode request key conflicts with original request")
	ErrCapacityExceeded                   = errors.New("episode capacity exceeded")
	ErrEpisodeAlreadyExists               = errors.New("episode already exists")
	ErrSynchronousCommit                  = errors.New("synchronous commit is not enabled for episode transaction")
	ErrInvalidAccountID                   = errors.New("invalid dashboard account id")
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

// DeadlineCycle is the outcome of one scheduler pass. An Episode whose work
// failed is skipped and listed, so one bad Episode cannot stop the others.
type DeadlineCycle struct {
	Enqueued int
	Skipped  []SkippedEpisode
	// Completed lists the Episodes whose work finished without error. An Episode
	// in neither list was not attempted this pass, for example because another
	// replica held its row.
	Completed []EpisodeRef
}

type EpisodeRef struct {
	TenantID  utilities.ID
	EpisodeID utilities.ID
}

type SkippedEpisode struct {
	TenantID  utilities.ID
	EpisodeID utilities.ID
	// Phase names the scheduler step that failed: deadline, presence_expiry or empty_linger.
	Phase string
	Err   error
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
	AdmissionPolicy               json.RawMessage          `json:"admission_policy"`
	Roles                         map[string][]string      `json:"roles"`
	DefaultEpisodeDurationSeconds int32                    `json:"default_episode_duration_seconds"`
	MaximumEpisodeDurationSeconds int32                    `json:"maximum_episode_duration_seconds"`
	LingerWindowSeconds           int32                    `json:"linger_window_seconds"`
	ArtifactPolicy                *artifactpolicy.Document `json:"artifact_policy,omitempty"`
	MediaPlaneBinding             *mediaplane.Binding      `json:"media_plane_binding,omitempty"`
}

// MediaPlaneBinding returns the provider application frozen when the Episode
// started. legacy reports an Episode that predates the binding: its snapshot has
// no media_plane_binding key. A stored null binding is not legacy: the Episode
// started without media, so it has no media service.
func (e Episode) MediaPlaneBinding() (binding *mediaplane.Binding, legacy bool, err error) {
	var snapshot struct {
		Binding json.RawMessage `json:"media_plane_binding"`
	}
	if len(e.ConfigSnapshot) == 0 {
		return nil, true, nil
	}
	if err := json.Unmarshal(e.ConfigSnapshot, &snapshot); err != nil {
		return nil, false, ErrInvalidConfigSnapshot
	}
	if snapshot.Binding == nil {
		return nil, true, nil
	}
	if err := json.Unmarshal(snapshot.Binding, &binding); err != nil {
		return nil, false, ErrInvalidConfigSnapshot
	}
	if binding == nil {
		return nil, false, nil
	}
	if err := binding.Validate(); err != nil {
		return nil, false, ErrInvalidConfigSnapshot
	}
	return binding, false, nil
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
