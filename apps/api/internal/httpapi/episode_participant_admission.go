package httpapi

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
)

// participantAdmitter admits a Participant to an Episode and returns the credentials the client joins with.
type participantAdmitter struct {
	service     EpisodeLifecycleService
	tokens      SyncTokenIssuer
	refresh     SyncTokenRefreshIssuer
	mediaTokens ParticipantMediaIssuer
	generations ParticipantGenerationAuthorizer
	spaces      SpaceService
	tenants     TenantService
	media       MediaPlaneResolver
}

func (a participantAdmitter) admit(ctx context.Context, request admitParticipantEndpointRequest) (participantLifecycleResponse, error) {
	// Refuse an SDK that cannot run the Episode's media before admission stores
	// the Participant and takes a join seat. Other resolution failures surface
	// from the join below, as before, so a waiting-room request needs no media.
	if _, err := resolveMediaPlaneForClients(ctx, a.media, a.spaces, a.tenants, request.TenantID, request.SpaceID, request.EpisodeID, request.MediaClients); errors.Is(err, mediaplane.ErrClientUnsupported) {
		return participantLifecycleResponse{}, err
	}
	admission, err := a.service.AdmitParticipant(ctx, episodes.AdmitParticipantInput{Admission: request.Body.Admission, TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID, Name: request.Body.Name, Metadata: request.Body.Metadata.Value, Role: request.Body.Role, IdentityID: request.IdentityID, IdentityExternalID: request.Body.IdentityExternalID, Request: episodes.Request{Key: request.RequestKey}})
	if err != nil {
		return participantLifecycleResponse{}, err
	}
	response := newParticipantLifecycleResponse(admission.Participant, admission.Intent)
	if admission.AdmissionRequest != nil {
		response.AdmissionRequest = &admissionRequestResponse{ID: admission.AdmissionRequest.ID.String(), Status: admission.AdmissionRequest.Status, ExpiresAt: admission.AdmissionRequest.ExpiresAt.UTC().Format(time.RFC3339)}
		return response, nil
	}
	syncCredential, err := a.issueSyncToken(ctx, admission, request.Body.Name)
	if err != nil {
		return participantLifecycleResponse{}, err
	}
	if a.tokens != nil || a.refresh != nil {
		response.SyncToken, response.ExpiresAt = syncCredential.Value, syncCredential.ExpiresAt.UTC().Format(time.RFC3339)
	}
	join, err := createParticipantJoin(ctx, a.spaces, a.tenants, a.media, admission.Participant, request.MediaClients)
	if err != nil {
		return participantLifecycleResponse{}, err
	}
	if join.Provider != "" {
		response.MediaPlane = &mediaPlaneResponse{Provider: string(join.Provider), ClientPayload: join.ClientPayload}
	}
	if !grantProvider(join.Provider) {
		return response, nil
	}
	access, err := a.bindAccess(ctx, request, admission, join, syncCredential)
	if err != nil {
		return participantLifecycleResponse{}, err
	}
	response.Access = access
	return response, nil
}

// issueSyncToken issues the Sync credential with the full Participant claims when a token issuer is present,
// or refreshes it from the stored subject; it returns an empty token when neither is configured.
func (a participantAdmitter) issueSyncToken(ctx context.Context, admission episodes.Admission, displayName string) (synctokens.Token, error) {
	participant := admission.Participant
	switch {
	case a.tokens != nil:
		return a.tokens.Issue(ctx, synctokens.Input{TenantID: participant.TenantID, SpaceID: participant.SpaceID, EpisodeID: participant.EpisodeID, StartedAt: &admission.Episode.StartedAt, ParticipantID: participant.ID, ParticipantGeneration: participant.Generation, AdmissionLifecycleIntentID: admission.Intent.ID, DisplayName: displayName, Role: participant.Role, Capabilities: append([]string(nil), participant.Capabilities...)})
	case a.refresh != nil:
		return a.refresh.IssueForParticipant(ctx, synctokens.SubjectKey{TenantID: participant.TenantID, SpaceID: participant.SpaceID, EpisodeID: participant.EpisodeID, ParticipantID: participant.ID})
	}
	return synctokens.Token{}, nil
}

// bindAccess records the media connection for the join and returns the combined access grant when both credentials exist.
func (a participantAdmitter) bindAccess(ctx context.Context, request admitParticipantEndpointRequest, admission episodes.Admission, join mediaplane.Join, syncCredential synctokens.Token) (*accessGrantResponse, error) {
	if a.generations == nil {
		return nil, apiErrorServiceUnavailable
	}
	participant := admission.Participant
	accessRequest := issueAccessGrantRequest{TenantID: participant.TenantID, SpaceID: participant.SpaceID, EpisodeID: participant.EpisodeID, ParticipantID: participant.ID, Body: issueAccessGrantBody{ParticipantGeneration: participant.Generation}}
	subject, err := accessGrantSubjectForJoin(accessRequest, join)
	if err != nil {
		return nil, err
	}
	var access *accessGrantResponse
	if a.mediaTokens != nil && syncCredential.Value != "" {
		mediaCredential, err := a.mediaTokens.Issue(observability.ContextWithAccessGrantClientProviders(ctx, request.MediaClients), subject)
		if err != nil {
			return nil, err
		}
		grant := newAccessGrantResponse(subject, syncCredential, mediaCredential, join)
		access = &grant
	}
	if err := a.generations.BindParticipantMediaConnection(ctx, subject); err != nil {
		return nil, err
	}
	return access, nil
}
