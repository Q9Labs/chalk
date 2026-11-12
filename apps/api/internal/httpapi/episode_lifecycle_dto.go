package httpapi

import (
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type createEpisodeRequest struct {
	Metadata  utilities.OptionalJSON `json:"metadata"`
	StartedAt *time.Time             `json:"started_at,omitempty"`
}

type createEpisodeEndpointRequest struct {
	TenantID     utilities.ID
	SpaceID      utilities.ID
	RequestKey   string
	MediaClients mediaplane.ClientProviders
	Body         createEpisodeRequest
}

type admitParticipantRequest struct {
	Admission          episodes.AdmissionMode `json:"admission,omitempty"`
	ParticipantID      string                 `json:"participant_id,omitempty"`
	Name               string                 `json:"name"`
	Metadata           utilities.OptionalJSON `json:"metadata"`
	Role               string                 `json:"role"`
	IdentityID         string                 `json:"identity_id,omitempty"`
	IdentityExternalID string                 `json:"identity_external_id,omitempty"`
}

type admitParticipantEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	RequestKey    string
	ParticipantID utilities.ID
	IdentityID    utilities.ID
	MediaClients  mediaplane.ClientProviders
	Body          admitParticipantRequest
}

type removeParticipantRequest struct {
	ParticipantGeneration int64 `json:"participant_generation"`
}

type removeParticipantEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	RequestKey    string
	ParticipantID utilities.ID
	Body          removeParticipantRequest
}

type endEpisodeEndpointRequest struct {
	TenantID   utilities.ID
	SpaceID    utilities.ID
	EpisodeID  utilities.ID
	RequestKey string
}

type setDeadlineRequest struct {
	DeadlineAt time.Time `json:"deadline_at"`
}

type setDeadlineEndpointRequest struct {
	TenantID   utilities.ID
	SpaceID    utilities.ID
	EpisodeID  utilities.ID
	RequestKey string
	Body       setDeadlineRequest
}

type issueSyncTokenEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
}

type episodeResponse struct {
	ID                 string  `json:"id"`
	TenantID           string  `json:"tenant_id"`
	SpaceID            string  `json:"space_id"`
	Status             string  `json:"status"`
	Metadata           any     `json:"metadata"`
	ConfigSnapshot     any     `json:"config_snapshot"`
	EndReason          *string `json:"end_reason,omitempty"`
	StartedAt          string  `json:"started_at"`
	EndedAt            string  `json:"ended_at,omitempty"`
	DeadlineAt         string  `json:"deadline_at"`
	DeadlineGeneration int64   `json:"deadline_generation"`
	UpdatedAt          string  `json:"updated_at"`
	CreatedAt          string  `json:"created_at"`
}

type episodeListResponse struct {
	Episodes   []episodeResponse  `json:"episodes"`
	Pagination paginationResponse `json:"pagination"`
}

type syncTokenResponse struct {
	SyncToken string `json:"sync_token"`
	ExpiresAt string `json:"expires_at"`
}

type lifecycleIntentResponse struct {
	ID                    string  `json:"id"`
	RequestKey            string  `json:"request_key"`
	IntentName            string  `json:"intent_name"`
	ParticipantID         *string `json:"participant_id,omitempty"`
	ParticipantGeneration *int64  `json:"participant_generation,omitempty"`
	Status                string  `json:"status"`
	CreatedAt             string  `json:"created_at"`
}

type participantResponse struct {
	ID           string   `json:"id"`
	TenantID     string   `json:"tenant_id"`
	SpaceID      string   `json:"space_id"`
	EpisodeID    string   `json:"episode_id"`
	IdentityID   *string  `json:"identity_id,omitempty"`
	Role         string   `json:"role"`
	Capabilities []string `json:"capabilities"`
	Generation   int64    `json:"generation"`
	Status       string   `json:"status"`
}

type participantLifecycleResponse struct {
	Participant      participantResponse       `json:"participant"`
	Intent           lifecycleIntentResponse   `json:"lifecycle_intent"`
	AdmissionRequest *admissionRequestResponse `json:"admission_request,omitempty"`
	Access           *accessGrantResponse      `json:"access,omitempty"`
	SyncToken        string                    `json:"sync_token,omitempty"`
	ExpiresAt        string                    `json:"expires_at,omitempty"`
	MediaPlane       *mediaPlaneResponse       `json:"media_plane,omitempty"`
}

type admissionRequestResponse struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	ExpiresAt string `json:"expires_at"`
}

type mediaPlaneResponse struct {
	Provider      string         `json:"provider"`
	ClientPayload map[string]any `json:"client_payload"`
}

type participantRemovalResponse struct {
	Participant participantResponse       `json:"participant"`
	Operation   externalOperationResponse `json:"external_operation"`
}

type episodeControlResponse struct {
	EpisodeID string                    `json:"episode_id"`
	Status    string                    `json:"status"`
	Operation externalOperationResponse `json:"external_operation"`
}

type externalOperationResponse struct {
	ID                          string  `json:"id"`
	RequestKey                  string  `json:"request_key"`
	OperationName               string  `json:"operation_name"`
	TargetParticipantID         *string `json:"target_participant_id,omitempty"`
	TargetParticipantGeneration *int64  `json:"target_participant_generation,omitempty"`
	DeadlineGeneration          *int64  `json:"deadline_generation,omitempty"`
	Status                      string  `json:"status"`
	CreatedAt                   string  `json:"created_at"`
}

func newEpisodeResponse(episode episodes.Episode) episodeResponse {
	startedAt := episode.StartedAt
	if startedAt.IsZero() && !episode.CreatedAt.IsZero() {
		// Legacy migrations can leave started_at blank; created_at is the persisted timestamp we can truthfully expose.
		startedAt = episode.CreatedAt
	}
	return episodeResponse{ID: episode.ID.String(), TenantID: episode.TenantID.String(), SpaceID: episode.SpaceID.String(), Status: episode.Status, Metadata: rawJSONValue(episode.Metadata), ConfigSnapshot: rawJSONValue(episode.ConfigSnapshot), EndReason: episode.EndReason, StartedAt: episodeTimestampString(startedAt), EndedAt: episodeTimestampString(episode.EndedAt), DeadlineAt: episodeTimestampString(episode.DeadlineAt), DeadlineGeneration: episode.DeadlineGeneration, UpdatedAt: episodeTimestampString(episode.UpdatedAt), CreatedAt: episodeTimestampString(episode.CreatedAt)}
}

func newParticipantResponse(participant episodes.Participant) participantResponse {
	return participantResponse{ID: participant.ID.String(), TenantID: participant.TenantID.String(), SpaceID: participant.SpaceID.String(), EpisodeID: participant.EpisodeID.String(), IdentityID: optionalIDString(participant.IdentityID), Role: participant.Role, Capabilities: append([]string{}, participant.Capabilities...), Generation: participant.Generation, Status: participant.Status}
}

func newParticipantLifecycleResponse(participant episodes.Participant, intent episodes.Intent) participantLifecycleResponse {
	return participantLifecycleResponse{Participant: newParticipantResponse(participant), Intent: newLifecycleIntentResponse(intent)}
}

func newLifecycleIntentResponse(intent episodes.Intent) lifecycleIntentResponse {
	response := lifecycleIntentResponse{ID: intent.ID.String(), RequestKey: intent.RequestKey, IntentName: intent.IntentName, Status: intent.Status, CreatedAt: episodeTimestampString(intent.CreatedAt)}
	if !intent.ParticipantID.IsZero() {
		id := intent.ParticipantID.String()
		response.ParticipantID = &id
		generation := intent.ParticipantGeneration
		response.ParticipantGeneration = &generation
	}
	return response
}

func newExternalOperationResponse(operation episodes.ExternalOperation) externalOperationResponse {
	response := externalOperationResponse{ID: operation.ID.String(), RequestKey: operation.RequestKey, OperationName: operation.OperationName, Status: operation.Status, CreatedAt: episodeTimestampString(operation.CreatedAt)}
	if !operation.TargetParticipantID.IsZero() {
		id := operation.TargetParticipantID.String()
		response.TargetParticipantID = &id
		generation := operation.TargetGeneration
		response.TargetParticipantGeneration = &generation
	}
	if operation.DeadlineGeneration > 0 {
		generation := operation.DeadlineGeneration
		response.DeadlineGeneration = &generation
	}
	return response
}

func newExternalOperationResponseFromIntent(intent episodes.Intent) externalOperationResponse {
	return newExternalOperationResponse(episodes.ExternalOperation{ID: intent.ID, RequestKey: intent.RequestKey, OperationName: intent.IntentName, TargetParticipantID: intent.ParticipantID, TargetGeneration: intent.ParticipantGeneration, Status: intent.Status, CreatedAt: intent.CreatedAt})
}

func episodeTimestampString(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return utilities.FormatTimestamp(value)
}
