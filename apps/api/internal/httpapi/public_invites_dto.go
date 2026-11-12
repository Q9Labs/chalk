package httpapi

import (
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type publicInviteResponse struct {
	SchemaVersion string     `json:"schema_version"`
	TenantID      string     `json:"tenant_id"`
	SpaceID       string     `json:"space_id"`
	CanonicalURL  string     `json:"canonical_url"`
	Enabled       bool       `json:"enabled"`
	Generation    uint64     `json:"generation"`
	PublicRole    string     `json:"public_role"`
	AdmissionMode string     `json:"admission_mode"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	RotatedAt     *time.Time `json:"rotated_at,omitempty"`
	DisabledAt    *time.Time `json:"disabled_at,omitempty"`
}

type publicAdmissionRequestResponse struct {
	DecisionState  publicinvites.AdmissionDecisionState `json:"decision_state"`
	DecisionAction publicinvites.AdmissionDecision      `json:"decision_action,omitempty"`

	RequestHandle string    `json:"request_handle"`
	DisplayName   string    `json:"display_name"`
	RequestedAt   time.Time `json:"requested_at"`
	ExpiresAt     time.Time `json:"expires_at"`
	State         string    `json:"state"`
}

type publicAdmissionRequestPageResponse struct {
	Requests []publicAdmissionRequestResponse `json:"requests"`
}

type publicSpacePresentationResponse struct {
	MaximumEpisodeDurationSeconds int32  `json:"maximum_episode_duration_seconds,omitempty"`
	Name                          string `json:"name"`
	Slug                          string `json:"slug"`
	AdmissionMode                 string `json:"admission_mode"`
}

type publicSpaceCreatedResponse struct {
	Presentation    publicSpacePresentationResponse `json:"space"`
	InviteLink      string                          `json:"invite_link"`
	LifecycleUntil  time.Time                       `json:"lifecycle_until"`
	Arrival         publicSpaceArrivalResponse      `json:"arrival"`
	GuestCredential string                          `json:"guest_credential,omitempty"`
}

type publicSpaceArrivalResponse struct {
	State           string                           `json:"state"`
	Presentation    *publicSpacePresentationResponse `json:"space,omitempty"`
	Identity        string                           `json:"identity,omitempty"`
	ArrivalHandle   string                           `json:"arrival_handle,omitempty"`
	RetryAfter      int                              `json:"retry_after,omitempty"`
	Access          *publicAccessGrantResponse       `json:"access,omitempty"`
	GuestCredential string                           `json:"guest_credential,omitempty"`
}

type publicAccessGrantResponse = accessGrantResponse

type publicInvitePathRequest struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
}

type updatePublicInviteRequest struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	Body     struct {
		Enabled bool `json:"enabled"`
	} `json:"-"`
}

type rotatePublicInviteRequest struct {
	TenantID   utilities.ID
	SpaceID    utilities.ID
	RequestKey string
}

type listPublicAdmissionRequestsRequest struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	State    string
}

type decidePublicAdmissionRequestRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	RequestHandle string
	RequestKey    string
}

type publicSpaceCreateRequest struct {
	DisplayName string `json:"display_name"`
}

type publicInviteArrivalRequest struct {
	Body struct {
		SpaceInviteToken string `json:"space_invite_token"`
		DisplayName      string `json:"display_name"`
	} `json:"-"`
	RequestKey        string
	ArrivalHandle     string
	GuestCredential   string
	Native            bool
	LegacyInviteLink  bool
	AccountID         utilities.ID
	AccountAuthorized bool
	MediaClients      mediaplane.ClientProviders
}

type publicInviteStatusRequest struct {
	ArrivalHandle   string
	GuestCredential string
	AccountID       utilities.ID
	Native          bool
	MediaClients    mediaplane.ClientProviders
}

type publicInviteRefreshRequest struct {
	ArrivalHandle          string
	GuestCredential        string
	MediaProof             string
	ReplaceMediaConnection bool
	AccountID              utilities.ID
	Native                 bool
	MediaClients           mediaplane.ClientProviders
}

type publicInviteLeaveRequest struct {
	ArrivalHandle   string
	GuestCredential string
	AccountID       utilities.ID
	Native          bool
}

func newPublicInviteResponse(managed publicinvites.ManagedInvite) publicInviteResponse {
	invite := managed.Invite
	response := publicInviteResponse{SchemaVersion: "cspi1", TenantID: invite.TenantID.String(), SpaceID: invite.SpaceID.String(), CanonicalURL: managed.CanonicalURL, Enabled: invite.Enabled, Generation: invite.Generation, PublicRole: invite.PublicRole, AdmissionMode: string(invite.AdmissionMode), CreatedAt: invite.CreatedAt, UpdatedAt: invite.UpdatedAt}
	if !invite.RotatedAt.IsZero() {
		rotatedAt := invite.RotatedAt
		response.RotatedAt = &rotatedAt
	}
	response.DisabledAt = invite.DisabledAt
	return response
}

func newPublicAdmissionRequestResponse(request publicinvites.AdmissionRequest) publicAdmissionRequestResponse {
	state := request.DecisionState
	if state == "" {
		state = publicinvites.AdmissionDecisionNone
	}
	return publicAdmissionRequestResponse{DecisionState: state, DecisionAction: request.DecisionAction, RequestHandle: request.RequestHandle.String(), DisplayName: request.DisplayName, RequestedAt: request.RequestedAt, ExpiresAt: request.ExpiresAt, State: string(request.State)}
}

func newPublicAdmissionRequestPageResponse(page publicinvites.AdmissionRequestPage) publicAdmissionRequestPageResponse {
	response := publicAdmissionRequestPageResponse{Requests: make([]publicAdmissionRequestResponse, 0, len(page.Requests))}
	for _, request := range page.Requests {
		response.Requests = append(response.Requests, newPublicAdmissionRequestResponse(request))
	}
	return response
}

func newPublicSpacePresentationResponse(presentation publicinvites.PublicSpacePresentation) publicSpacePresentationResponse {
	return publicSpacePresentationResponse{Name: presentation.Name, Slug: presentation.Slug, AdmissionMode: string(presentation.AdmissionMode), MaximumEpisodeDurationSeconds: presentation.MaximumEpisodeDurationSeconds}
}

func newPublicSpaceCreatedResponse(created publicinvites.PublicSpaceCreated) publicSpaceCreatedResponse {
	return publicSpaceCreatedResponse{Presentation: newPublicSpacePresentationResponse(created.Presentation), InviteLink: created.InviteLink, LifecycleUntil: created.LifecycleUntil, Arrival: newPublicSpaceArrivalResponse(created.Arrival), GuestCredential: created.GuestCredential}
}

func newPublicSpaceArrivalResponse(arrival publicinvites.PublicSpaceArrival) publicSpaceArrivalResponse {
	response := publicSpaceArrivalResponse{State: string(arrival.State), Identity: string(arrival.Identity), ArrivalHandle: arrival.ArrivalHandle, RetryAfter: arrival.RetryAfter, GuestCredential: arrival.GuestCredential}
	if arrival.Presentation != nil {
		presentation := newPublicSpacePresentationResponse(*arrival.Presentation)
		response.Presentation = &presentation
	}
	if arrival.Access != nil {
		grant := newPublicAccessGrantResponse(*arrival.Access)
		response.Access = &grant
	}
	return response
}

func newPublicAccessGrantResponse(grant publicinvites.PublicAccessGrant) publicAccessGrantResponse {
	expiresAt := grant.ExpiresAt.UTC().Format(time.RFC3339)
	response := publicAccessGrantResponse{
		EpisodeStartedAt: episodeStartedAt(grant.StartedAt),
		Subject: accessGrantSubjectResponse{
			TenantID: grant.TenantID.String(), SpaceID: grant.SpaceID.String(), EpisodeID: grant.EpisodeID.String(),
			ParticipantID: grant.ParticipantID.String(), ParticipantGeneration: grant.ParticipantGeneration,
		},
		Sync:  accessGrantTokenResponse{Token: grant.SyncToken, ExpiresAt: expiresAt},
		Media: accessGrantMediaResponse{Token: grant.MediaToken, ExpiresAt: expiresAt, Provider: grant.Provider, ClientPayload: publicAccessClientPayload(grant)},
	}

	return response
}

func publicAccessClientPayload(grant publicinvites.PublicAccessGrant) map[string]any {
	switch grant.Provider {
	case publicinvites.PublicProviderCloudflareSFU:
		return map[string]any{
			"connectionId": grant.ClientPayload.ConnectionID,
			"stunServer":   grant.ClientPayload.StunServer,
			"iceServers":   grant.ClientPayload.ICEServers,
		}
	case publicinvites.PublicProviderChalkSFU:
		return map[string]any{
			"connectionId": grant.ClientPayload.ConnectionID,
			"provider":     publicinvites.PublicProviderChalkSFU,
			"episodeRef":   grant.ClientPayload.EpisodeRef,
			"iceServers":   grant.ClientPayload.ICEServers,
			"capabilities": chalkSFUCapabilities(grant.ClientPayload.Capabilities),
		}

	default:
		return map[string]any{}
	}
}

func chalkSFUCapabilities(c publicinvites.PublicAccessCapabilities) map[string]any {
	capabilities := map[string]any{
		"serverLayerAdaptation": c.ServerLayerAdaptation,
		"subscriptionState":     c.SubscriptionState,
		"iceRestart":            c.ICERestart,
		"pullPublished":         c.PullPublished,
		"unifiedSignaling":      c.UnifiedSignaling,
		"muteInPlace":           c.MuteInPlace,
		"keepsIdleSession":      c.KeepsIdleSession,
	}
	if c.DirectSignalingURL != "" {
		capabilities["directSignalingUrl"] = c.DirectSignalingURL
	}
	return capabilities
}
