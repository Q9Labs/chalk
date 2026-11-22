package httpapi

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
)

type accessGrantSubjectResponse struct {
	TenantID              string `json:"tenant_id"`
	SpaceID               string `json:"space_id"`
	EpisodeID             string `json:"episode_id"`
	ParticipantID         string `json:"participant_id"`
	ParticipantGeneration int64  `json:"participant_generation"`
}

type accessGrantTokenResponse struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at"`
}

type accessGrantMediaResponse struct {
	Token         string         `json:"token"`
	ExpiresAt     string         `json:"expires_at"`
	Provider      string         `json:"provider"`
	ClientPayload map[string]any `json:"client_payload"`
}

type accessGrantResponse struct {
	EpisodeStartedAt *string                    `json:"episode_started_at,omitempty"`
	Subject          accessGrantSubjectResponse `json:"subject"`
	Sync             accessGrantTokenResponse   `json:"sync"`
	Media            accessGrantMediaResponse   `json:"media"`
	// Telemetry is the credential for the telemetry route alone, valid for 24 hours. It is optional in the contract because an
	// API release that predates it omits it, and a client then sends telemetry under the media credential.
	Telemetry *accessGrantTokenResponse `json:"telemetry,omitempty"`
}

// issueGrantCredentials issues the media and telemetry credentials an access grant carries. On failure it names the
// stage that failed, for the access-grant failure log.
func issueGrantCredentials(ctx context.Context, issuer ParticipantMediaIssuer, clients mediaplane.ClientProviders, subject accessgrants.Subject) (accessgrants.MediaCredential, accessgrants.TelemetryCredential, string, error) {
	media, err := issuer.Issue(observability.ContextWithAccessGrantClientProviders(ctx, clients), subject)
	if err != nil {
		return accessgrants.MediaCredential{}, accessgrants.TelemetryCredential{}, "media_credential", err
	}
	telemetry, err := issuer.IssueTelemetry(ctx, subject)
	if err != nil {
		return accessgrants.MediaCredential{}, accessgrants.TelemetryCredential{}, "telemetry_credential", err
	}
	return media, telemetry, "", nil
}

func newAccessGrantResponse(subject accessgrants.Subject, syncCredential synctokens.Token, mediaCredential accessgrants.MediaCredential, telemetryCredential accessgrants.TelemetryCredential, join mediaplane.Join) accessGrantResponse {
	return accessGrantResponse{
		EpisodeStartedAt: episodeStartedAt(syncCredential.StartedAt),
		Subject: accessGrantSubjectResponse{
			TenantID: subject.TenantID.String(), SpaceID: subject.SpaceID.String(), EpisodeID: subject.EpisodeID.String(),
			ParticipantID: subject.ParticipantID.String(), ParticipantGeneration: subject.ParticipantGeneration,
		},
		Sync:      accessGrantTokenResponse{Token: syncCredential.Value, ExpiresAt: syncCredential.ExpiresAt.UTC().Format(time.RFC3339)},
		Media:     accessGrantMediaResponse{Token: mediaCredential.Token, ExpiresAt: mediaCredential.ExpiresAt.UTC().Format(time.RFC3339), Provider: subject.Provider, ClientPayload: join.ClientPayload},
		Telemetry: &accessGrantTokenResponse{Token: telemetryCredential.Token, ExpiresAt: telemetryCredential.ExpiresAt.UTC().Format(time.RFC3339)},
	}
}

func episodeStartedAt(value *time.Time) *string {
	if value == nil || value.IsZero() {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}

func newPublicAccessGrantResponse(grant publicinvites.PublicAccessGrant) publicAccessGrantResponse {
	expiresAt := grant.ExpiresAt.UTC().Format(time.RFC3339)
	response := publicAccessGrantResponse{
		EpisodeStartedAt: episodeStartedAt(grant.StartedAt),
		Subject: accessGrantSubjectResponse{
			TenantID: grant.TenantID.String(), SpaceID: grant.SpaceID.String(), EpisodeID: grant.EpisodeID.String(),
			ParticipantID: grant.ParticipantID.String(), ParticipantGeneration: grant.ParticipantGeneration,
		},
		Sync:      accessGrantTokenResponse{Token: grant.SyncToken, ExpiresAt: expiresAt},
		Media:     accessGrantMediaResponse{Token: grant.MediaToken, ExpiresAt: expiresAt, Provider: grant.Provider, ClientPayload: publicAccessClientPayload(grant)},
		Telemetry: &accessGrantTokenResponse{Token: grant.Telemetry.Token, ExpiresAt: grant.Telemetry.ExpiresAt.UTC().Format(time.RFC3339)},
	}

	return response
}

func publicAccessClientPayload(grant publicinvites.PublicAccessGrant) map[string]any {
	if grant.Provider != publicinvites.PublicProviderChalkSFU {
		return map[string]any{}
	}
	return map[string]any{
		"connectionId": grant.ClientPayload.ConnectionID,
		"provider":     publicinvites.PublicProviderChalkSFU,
		"episodeRef":   grant.ClientPayload.EpisodeRef,
		"iceServers":   grant.ClientPayload.ICEServers,
		"capabilities": chalkSFUCapabilities(grant.ClientPayload.Capabilities),
	}
}
