package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mcptools"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func bindMCPEpisodeTools(server *mcp.Server, o Options) {
	mcptools.Bind(server, mcptools.InspectEpisodes, func(ctx context.Context, i mcptools.EpisodesViewInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		switch i.View {
		case "episode":
			return mcpInvoke(b, getEpisodeEndpoint(o.Episodes, o.TenantAuthz), getEpisodeRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), EpisodeID: b.id(i.EpisodeID)})
		case "attendance":
			return mcpInvoke(b, getEpisodeAttendanceEndpoint(o.Episodes, o.TenantAuthz), getEpisodeRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), EpisodeID: b.id(i.EpisodeID)})
		case "live":
			return mcpInvoke(b, listSpaceLiveEpisodesEndpoint(o.Episodes, o.TenantAuthz), listSpaceLiveEpisodesRequest{TenantID: b.tenant, SpaceIDs: b.ids(i.SpaceIDs, episodes.MaximumLiveEpisodeSpaces)})
		case "activity":
			return mcpInvoke(b, listSpaceActivityEndpoint(o.Episodes, o.TenantAuthz), listSpaceActivityRequest{TenantID: b.tenant, SpaceIDs: b.ids(i.SpaceIDs, episodes.MaximumActivitySpaces)})
		case "admissions":
			return mcpInvoke(b, listPublicAdmissionRequestsEndpoint(o.PublicInvites, o.TenantAuthz), listPublicAdmissionRequestsRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), State: i.State})
		default:
			return mcpInvoke(b, listEpisodesEndpoint(o.Episodes, o.TenantAuthz), listEpisodesRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), Page: b.page(i.PageInput)})
		}
	})
	bindMCPEndpoint(server, mcptools.CreateEpisode, createEpisodeEndpoint(o.Episodes, o.TenantAuthz), func(b *mcpRequest, i mcptools.SpaceBodyInput[createEpisodeRequest]) createEpisodeEndpointRequest {
		// The tool has no SDK to ask, like its admit and grant tools below.
		return createEpisodeEndpointRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), RequestKey: i.RequestKey, MediaClients: mediaplane.AllClientProviders(), Body: i.Body}
	})
	bindMCPEndpoint(server, mcptools.EndEpisode, endEpisodeEndpoint(o.Episodes, o.TenantAuthz), func(b *mcpRequest, i mcptools.EpisodeInput) endEpisodeEndpointRequest {
		return endEpisodeEndpointRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), EpisodeID: b.id(i.EpisodeID), RequestKey: i.RequestKey}
	})
	bindMCPEndpoint(server, mcptools.SetEpisodeDeadline, setDeadlineEndpoint(o.Episodes, o.TenantAuthz), func(b *mcpRequest, i mcptools.DeadlineInput) setDeadlineEndpointRequest {
		deadline, err := time.Parse(time.RFC3339Nano, i.DeadlineAt)
		if err != nil {
			b.err = apiErrorInvalidRequest
		}
		return setDeadlineEndpointRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), EpisodeID: b.id(i.EpisodeID), RequestKey: i.RequestKey, Body: setDeadlineRequest{DeadlineAt: deadline}}
	})
	mcptools.Bind(server, mcptools.DecideAdmissionRequest, func(ctx context.Context, i mcptools.AdmissionDecisionInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		request := decidePublicAdmissionRequestRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), RequestHandle: i.RequestHandle, RequestKey: i.RequestKey}
		switch i.Decision {
		case "approve":
			return mcpInvoke(b, approvePublicAdmissionRequestEndpoint(o.PublicInvites, o.TenantAuthz, nil), request)
		case "deny":
			return mcpInvoke(b, denyPublicAdmissionRequestEndpoint(o.PublicInvites, o.TenantAuthz, nil), request)
		default:
			return nil, mcpError(apiErrorInvalidRequest)
		}
	})
	mcptools.Bind(server, mcptools.ControlCall, func(ctx context.Context, i mcptools.CallInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		space, episode, participant := b.id(i.SpaceID), b.id(i.EpisodeID), b.optionalID(i.ParticipantID)
		var (
			data json.RawMessage
			err  error
		)
		switch i.Action {
		case "admit":
			endpoint := admitParticipantEndpoint(o.Episodes, o.SyncTokens, o.SyncTokenRefresh, o.ParticipantMediaIssuer, o.ParticipantGeneration, o.Spaces, o.Tenants, o.MediaPlane, o.TenantAuthz)
			data, err = mcpInvoke(b, endpoint, admitParticipantEndpointRequest{TenantID: b.tenant, SpaceID: space, EpisodeID: episode, RequestKey: i.RequestKey, MediaClients: mediaplane.AllClientProviders(), ParticipantID: participant, IdentityID: b.optionalID(i.IdentityID), Body: admitParticipantRequest{Admission: episodes.AdmissionMode(i.Admission), Name: i.Name, Metadata: utilities.OptionalJSON{Set: len(i.Metadata) > 0, Value: i.Metadata}, Role: i.Role, IdentityID: i.IdentityID, IdentityExternalID: i.IdentityExternalID}})
		case "sync_token":
			data, err = mcpInvoke(b, issueSyncTokenEndpoint(o.SyncTokenRefresh, o.TenantAuthz), issueSyncTokenEndpointRequest{TenantID: b.tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant})
		case "access_grant":
			// An empty fence must never mean "replace without a check": reject it here, whatever replace_media_connection says.
			if i.ExpectedMediaConnectionID != nil && strings.TrimSpace(*i.ExpectedMediaConnectionID) == "" {
				return nil, mcpError(apiErrorInvalidRequest)
			}
			body := issueAccessGrantBody{ParticipantGeneration: i.ParticipantGeneration, CurrentMediaToken: i.CurrentMediaToken, ReplaceMediaConnection: i.ReplaceMediaConnection, ExpectedMediaConnectionID: i.ExpectedMediaConnectionID}
			endpoint := issueAccessGrantEndpoint(o.SyncTokenRefresh, o.ParticipantMediaIssuer, o.ParticipantMediaVerify, o.ParticipantMediaActive, o.ParticipantGeneration, o.Spaces, o.Tenants, o.MediaPlane, o.TenantAuthz)
			data, err = mcpInvoke(b, endpoint, issueAccessGrantRequest{TenantID: b.tenant, SpaceID: space, EpisodeID: episode, ParticipantID: participant, MediaClients: mediaplane.AllClientProviders(), Body: body})
		default:
			return nil, mcpError(apiErrorInvalidRequest)
		}
		outcome := "ok"
		if err != nil {
			outcome = "rejected"
		}
		// The audit line names who minted credentials for whom. It never holds a credential.
		slog.InfoContext(ctx, "MCP call credentials requested", "event", "mcp.call_credentials.requested", "action", i.Action, "tenant_id", b.tenant.String(), "actor_id", mcptools.Connection(ctx).ActorID, "space_id", space.String(), "episode_id", episode.String(), "participant_id", participant.String(), "outcome", outcome)
		return data, err
	})
	bindMCPEndpoint(server, mcptools.RemoveParticipant, removeParticipantEndpoint(o.Episodes, o.TenantAuthz), func(b *mcpRequest, i mcptools.RemovalInput) removeParticipantEndpointRequest {
		return removeParticipantEndpointRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), EpisodeID: b.id(i.EpisodeID), ParticipantID: b.id(i.ParticipantID), RequestKey: i.RequestKey, Body: removeParticipantRequest{ParticipantGeneration: i.ParticipantGeneration}}
	})
}
