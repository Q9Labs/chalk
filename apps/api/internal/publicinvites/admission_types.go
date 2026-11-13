package publicinvites

import (
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type AdmissionRequestState string

const (
	AdmissionRequestPending     AdmissionRequestState = "pending"
	AdmissionRequestApproved    AdmissionRequestState = "approved"
	AdmissionRequestDenied      AdmissionRequestState = "denied"
	AdmissionRequestExpired     AdmissionRequestState = "expired"
	AdmissionRequestInvalidated AdmissionRequestState = "invalidated"
)

type AdmissionBinding struct {
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
}

type AdmissionDecisionState string

const (
	AdmissionDecisionNone      AdmissionDecisionState = "none"
	AdmissionDecisionInFlight  AdmissionDecisionState = "in_flight"
	AdmissionDecisionRetryable AdmissionDecisionState = "retryable"
)

type AdmissionRequest struct {
	DecisionState  AdmissionDecisionState
	DecisionAction AdmissionDecision

	Binding       *AdmissionBinding
	RequestHandle utilities.ID
	ArrivalHandle utilities.ID
	TenantID      utilities.ID
	SpaceID       utilities.ID
	DisplayName   string
	State         AdmissionRequestState
	RequestedAt   time.Time
	ExpiresAt     time.Time
	DecidedAt     *time.Time
	DecidedBy     utilities.ID
}

type AdmissionDecision string

const (
	DecisionApprove AdmissionDecision = "approve"
	DecisionDeny    AdmissionDecision = "deny"
)

func (decision AdmissionDecision) valid() bool {
	return decision == DecisionApprove || decision == DecisionDeny
}

type CreateAdmissionRequestInput struct {
	ArrivalHandle utilities.ID
	DisplayName   string
	ExpiresAt     time.Time
	// MediaClients is what the knocking guest's SDK can run. Its request creates the Episode when none is live.
	MediaClients mediaplane.ClientProviders
}

type DecideAdmissionRequestInput struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	RequestHandle utilities.ID
	Decision      AdmissionDecision
	ActorID       utilities.ID
	RequestKey    string
}
