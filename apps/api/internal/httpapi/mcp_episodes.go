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
	bindMCPEndpoint(server, mcpapi.ListEpisodes, listEpisodesEndpoint(o.Episodes, o.TenantAuthz), func(b *mcpRequest, i mcpapi.SpacePageInput) listEpisodesRequest {
		return listEpisodesRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), Page: b.page(i.PageInput)}
	})
	mcpapi.Bind(server, mcpapi.InspectEpisode, func(ctx context.Context, i mcpapi.EpisodeInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		request := getEpisodeRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), EpisodeID: b.id(i.EpisodeID)}
		if i.View == "attendance" {
			return mcpInvoke(b, getEpisodeAttendanceEndpoint(o.Episodes, o.TenantAuthz), request)
		}
		return mcpInvoke(b, getEpisodeEndpoint(o.Episodes, o.TenantAuthz), request)
	})
	bindMCPEndpoint(server, mcpapi.CreateEpisode, createEpisodeEndpoint(o.Episodes, o.TenantAuthz), func(b *mcpRequest, i mcpapi.SpaceBodyInput[createEpisodeRequest]) createEpisodeEndpointRequest {
		return createEpisodeEndpointRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), RequestKey: i.RequestKey, Body: i.Body}
	})
	bindMCPEndpoint(server, mcpapi.ListLiveEpisodes, listSpaceLiveEpisodesEndpoint(o.Episodes, o.TenantAuthz), func(b *mcpRequest, i mcpapi.SpaceSetInput) listSpaceLiveEpisodesRequest {
		return listSpaceLiveEpisodesRequest{TenantID: b.tenant, SpaceIDs: b.ids(i.SpaceIDs, episodes.MaximumLiveEpisodeSpaces)}
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
	bindMCPEndpoint(server, mcpapi.ListAdmissionRequests, listPublicAdmissionRequestsEndpoint(o.PublicInvites, o.TenantAuthz), func(b *mcpRequest, i mcpapi.AdmissionsInput) listPublicAdmissionRequestsRequest {
		return listPublicAdmissionRequestsRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID), State: i.State}
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
