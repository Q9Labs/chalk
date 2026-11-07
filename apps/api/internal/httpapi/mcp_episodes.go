package httpapi

import (
	"context"
	"encoding/json"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	mcpapi "github.com/q9labs/chalk/features/mcp/api"
)

func bindMCPEpisodeTools(server *mcp.Server, o Options) {
	mcpapi.Bind(server, mcpapi.InspectEpisodes, func(ctx context.Context, i mcpapi.EpisodesViewInput) (json.RawMessage, error) {
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
	bindMCPEndpoint(server, mcpapi.CreateEpisode, createEpisodeEndpoint(o.Episodes, o.TenantAuthz), func(b *mcpRequest, i mcpapi.SpaceBodyInput[createEpisodeRequest]) createEpisodeEndpointRequest {
		return createEpisodeEndpointRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), RequestKey: i.RequestKey, Body: i.Body}
	})
	bindMCPEndpoint(server, mcpapi.EndEpisode, endEpisodeEndpoint(o.Episodes, o.TenantAuthz), func(b *mcpRequest, i mcpapi.EpisodeInput) endEpisodeEndpointRequest {
		return endEpisodeEndpointRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), EpisodeID: b.id(i.EpisodeID), RequestKey: i.RequestKey}
	})
	bindMCPEndpoint(server, mcpapi.SetEpisodeDeadline, setDeadlineEndpoint(o.Episodes, o.TenantAuthz), func(b *mcpRequest, i mcpapi.DeadlineInput) setDeadlineEndpointRequest {
		deadline, err := time.Parse(time.RFC3339Nano, i.DeadlineAt)
		if err != nil {
			b.err = apiErrorInvalidRequest
		}
		return setDeadlineEndpointRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), EpisodeID: b.id(i.EpisodeID), RequestKey: i.RequestKey, Body: setDeadlineRequest{DeadlineAt: deadline}}
	})
	mcpapi.Bind(server, mcpapi.DecideAdmissionRequest, func(ctx context.Context, i mcpapi.AdmissionDecisionInput) (json.RawMessage, error) {
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
	bindMCPEndpoint(server, mcpapi.RemoveParticipant, removeParticipantEndpoint(o.Episodes, o.TenantAuthz), func(b *mcpRequest, i mcpapi.RemovalInput) removeParticipantEndpointRequest {
		return removeParticipantEndpointRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), EpisodeID: b.id(i.EpisodeID), ParticipantID: b.id(i.ParticipantID), RequestKey: i.RequestKey, Body: removeParticipantRequest{ParticipantGeneration: i.ParticipantGeneration}}
	})
}
