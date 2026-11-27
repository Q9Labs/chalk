package httpapi

import (
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type admitParticipantRequest struct {
	Admission          episodes.AdmissionMode `json:"admission,omitempty"`
	ParticipantID      string                 `json:"participant_id,omitempty"`
	Name               string                 `json:"name"`
	Description        string                 `json:"description,omitempty"`
	Notice             string                 `json:"notice,omitempty"`
	Metadata           utilities.OptionalJSON `json:"metadata"`
	Role               string                 `json:"role"`
	IdentityID         string                 `json:"identity_id,omitempty"`
	IdentityExternalID string                 `json:"identity_external_id,omitempty"`
	IdentityKind       episodes.IdentityKind  `json:"identity_kind,omitempty"`
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

// checkAdmissionPreconditions refuses an agent identity the caller may not register and an SDK
// that cannot run the Episode's media before admission stores the Participant and takes a join
// seat. Other resolution failures surface from the join below, so a waiting-room request needs no media.
func checkAdmissionPreconditions(ctx context.Context, request admitParticipantEndpointRequest, media MediaPlaneResolver, spacesService SpaceService, tenantsService TenantService) error {
	if err := authorizeParticipantDetails(ctx, request.Body.IdentityKind, request.Body.Description, request.Body.Notice); err != nil {
		return err
	}
	if _, err := resolveMediaPlaneForClients(ctx, media, spacesService, tenantsService, request.TenantID, request.SpaceID, request.EpisodeID, request.MediaClients); errors.Is(err, mediaplane.ErrClientUnsupported) {
		return err
	}
	return nil
}

func authorizeParticipantDetails(ctx context.Context, kind episodes.IdentityKind, description, notice string) error {
	if kind != episodes.IdentityKindAgent && description == "" && notice == "" {
		return nil
	}
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}
	if principal.Kind == authentication.PrincipalAPIKey || principal.Kind == authentication.PrincipalService {
		return nil
	}
	if kind == episodes.IdentityKindAgent {
		return apiErrorIdentityKindForbidden
	}
	if description != "" {
		return apiErrorParticipantDescriptionForbidden
	}
	return apiErrorParticipantNoticeForbidden
}
