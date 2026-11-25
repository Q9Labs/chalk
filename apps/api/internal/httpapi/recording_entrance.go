package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type RecordingEntrancePreparer interface {
	PrepareEntrance(context.Context, utilities.ID, utilities.ID, time.Time) (bool, error)
}

type EntranceInviteResolver interface {
	ResolveInviteToken(context.Context, string) (publicinvites.Invite, publicinvites.Token, error)
	ListLobbyParticipants(context.Context, utilities.ID, utilities.ID) ([]publicinvites.LobbyParticipant, error)
}

type entranceInviteBody struct {
	SpaceInviteToken string `json:"space_invite_token"`
}

type entrancePreparationResponse struct {
	Prepared     bool                       `json:"prepared"`
	Participants []lobbyParticipantResponse `json:"participants,omitempty"`
}

func recordingEntranceEndpoint(preparer RecordingEntrancePreparer, authorizer TenantAuthorizer) Endpoint[getSpaceRequest, entrancePreparationResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/entrance", "prepareSpaceEntrance", decodeGetSpaceRequest, func(ctx context.Context, request getSpaceRequest) (entrancePreparationResponse, error) {
		return prepareEntrance(ctx, preparer, request.TenantID, request.SpaceID)
	}).Permission(authorizer, readSpacesPermission).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter()).Responds(http.StatusOK, "EntrancePreparation", entrancePreparationResponse{}).
		Errors(spaceReadErrors(apiErrorInvalidSpaceID, apiErrorSpaceNotFound, apiErrorRateLimited)...).ErrorRules(spaceRules).
		Middleware(noStoreResponses)
}

func publicRecordingEntranceEndpoint(preparer RecordingEntrancePreparer, invites EntranceInviteResolver, origin func(http.Handler) http.Handler) Endpoint[entranceInviteBody, entrancePreparationResponse] {
	middlewares := []func(http.Handler) http.Handler{noStoreResponses, publicInviteTelemetry("public.entrance")}
	if origin != nil {
		middlewares = append(middlewares, origin)
	}
	return Post("/v1/public/space-invite-entrance", "preparePublicSpaceEntrance", func(r *http.Request) (entranceInviteBody, error) {
		body, err := decodeJSONBody[entranceInviteBody](r)
		if err != nil {
			return body, err
		}
		if strings.TrimSpace(body.SpaceInviteToken) == "" {
			return body, apiErrorInvalidPublicInviteToken
		}
		return body, nil
	}, func(ctx context.Context, body entranceInviteBody) (entrancePreparationResponse, error) {
		invite, _, err := invites.ResolveInviteToken(ctx, strings.TrimSpace(body.SpaceInviteToken))
		if err != nil {
			return entrancePreparationResponse{}, err
		}
		preparation, err := prepareEntrance(ctx, preparer, invite.TenantID, invite.SpaceID)
		if err != nil {
			return preparation, err
		}
		participants, err := invites.ListLobbyParticipants(ctx, invite.TenantID, invite.SpaceID)
		if err != nil {
			return preparation, err
		}
		preparation.Participants = newPublicLobbyParticipantResponse(participants)
		return preparation, nil
	}).Needs(invites).RateLimit(authenticatedWriteRateLimit).Middleware(middlewares...).
		RequestBody("EntranceInvite", entranceInviteBody{}).Responds(http.StatusOK, "EntrancePreparation", entrancePreparationResponse{}).
		Errors(apiErrorInvalidPublicInviteToken, apiErrorPublicInviteUnavailable, apiErrorSpaceNotFound, apiErrorServiceUnavailable, apiErrorInternal, apiErrorRateLimited).
		ErrorRules(publicInviteRules)
}

func prepareEntrance(ctx context.Context, preparer RecordingEntrancePreparer, tenantID, spaceID utilities.ID) (entrancePreparationResponse, error) {
	if preparer == nil {
		return entrancePreparationResponse{}, nil
	}
	prepared, err := preparer.PrepareEntrance(ctx, tenantID, spaceID, time.Now().UTC())
	if err != nil {
		slog.WarnContext(ctx, "Capture Entrance preparation failed", "event", "recording.entrance.failed")
	}
	return entrancePreparationResponse{Prepared: prepared}, err
}

type lobbyParticipantResponse struct {
	DisplayName  string  `json:"display_name"`
	IdentityKind string  `json:"identity_kind"`
	Notice       *string `json:"notice,omitempty"`
}

func newPublicLobbyParticipantResponse(participants []publicinvites.LobbyParticipant) []lobbyParticipantResponse {
	result := make([]lobbyParticipantResponse, 0, len(participants))
	for _, participant := range participants {
		result = append(result, lobbyParticipantResponse{DisplayName: participant.DisplayName, IdentityKind: participant.IdentityKind, Notice: agentNotice(participant.IdentityKind, participant.Notice)})
	}
	return result
}

func agentNotice(kind, notice string) *string {
	if kind != "agent" || notice == "" {
		return nil
	}
	return &notice
}
