package httpapi

import (
	"context"
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
	mcpapi "github.com/q9labs/chalk/features/mcp/api"
)

func bindMCPSpaceTools(server *mcpapi.Server, o Options) {
	bindMCPEndpoint(server, mcpapi.ListSpaceActivity, listSpaceActivityEndpoint(o.Episodes, o.TenantAuthz), func(b *mcpRequest, i mcpapi.SpaceSetInput) listSpaceActivityRequest {
		return listSpaceActivityRequest{TenantID: b.tenant, SpaceIDs: b.ids(i.SpaceIDs, episodes.MaximumActivitySpaces)}
	})
	bindMCPEndpoint(server, mcpapi.ListSpaces, listSpacesEndpoint(o.Spaces, o.TenantAuthz), func(b *mcpRequest, i mcpapi.SpacesInput) listSpacesRequest {
		return listSpacesRequest{TenantID: b.tenant, Page: b.page(i.PageInput), Archived: i.Archived}
	})
	mcpapi.Bind(server, mcpapi.InspectSpace, func(ctx context.Context, i mcpapi.SpaceInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		spaceID := b.id(i.SpaceID)
		if i.View == "invite" {
			return mcpInvoke(b, getSpacePublicInviteEndpoint(o.PublicInvites, o.TenantAuthz), publicInvitePathRequest{TenantID: b.tenant, SpaceID: spaceID})
		}
		return mcpInvoke(b, getSpaceEndpoint(o.Spaces, o.TenantAuthz), getSpaceRequest{TenantID: b.tenant, SpaceID: spaceID})
	})
	bindMCPEndpoint(server, mcpapi.CreateSpace, createSpaceEndpoint(o.Spaces, o.TenantAuthz), func(b *mcpRequest, i mcpapi.BodyInput[createSpaceRequest]) createSpaceEndpointRequest {
		return createSpaceEndpointRequest{TenantID: b.tenant, RequestKey: i.RequestKey, Body: i.Body}
	})
	mcpapi.Bind(server, mcpapi.ConfigureSpace, func(ctx context.Context, i mcpapi.SpaceChangeInput[updateSpaceRequest]) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		spaceID := b.id(i.SpaceID)
		switch i.Action {
		case "settings":
			return mcpInvoke(b, updateSpaceEndpoint(o.Spaces, o.TenantAuthz), updateSpaceEndpointRequest{TenantID: b.tenant, SpaceID: spaceID, Body: i.Settings})
		case "invite":
			return mcpInvoke(b, updateSpacePublicInviteEndpoint(o.PublicInvites, o.TenantAuthz, nil), updatePublicInviteRequest{TenantID: b.tenant, SpaceID: spaceID, Body: struct {
				Enabled bool `json:"enabled"`
			}{i.Enabled}})
		case "rotate_invite":
			return mcpInvoke(b, rotateSpacePublicInviteEndpoint(o.PublicInvites, o.TenantAuthz, nil), rotatePublicInviteRequest{TenantID: b.tenant, SpaceID: spaceID, RequestKey: i.RequestKey})
		default:
			return nil, mcpError(apiErrorInvalidRequest)
		}
	})
	mcpapi.Bind(server, mcpapi.SetSpaceArchived, func(ctx context.Context, i mcpapi.ArchiveInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		request := getSpaceRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID)}
		if i.Archived {
			return mcpInvoke(b, archiveSpaceEndpoint(o.Spaces, o.TenantAuthz), request)
		}
		return mcpInvoke(b, restoreSpaceEndpoint(o.Spaces, o.TenantAuthz), request)
	})
	mcpapi.Bind(server, mcpapi.PrepareRecording, func(ctx context.Context, i mcpapi.PreparationInput) (json.RawMessage, error) {
		scope := "spaces:write"
		if i.Action == "inspect" {
			scope = "spaces:read"
		}
		if err := mcpapi.RequireScope(ctx, scope); err != nil {
			return nil, err
		}
		b := newMCPRequest(ctx)
		spaceID := b.id(i.SpaceID)
		switch i.Action {
		case "inspect":
			return mcpInvoke(b, getRecordingPreparationEndpoint(o.RecordingPreparations, o.TenantAuthz), getSpaceRequest{TenantID: b.tenant, SpaceID: spaceID})
		case "prepare":
			startsAt, err := time.Parse(time.RFC3339Nano, i.StartsAt)
			if err != nil {
				b.err = apiErrorInvalidPreparation
			}
			return mcpInvoke(b, prepareRecordingEndpoint(o.RecordingPreparations, o.TenantAuthz), recordingpreparation.Input{TenantID: b.tenant, SpaceID: spaceID, StartsAt: startsAt, ExpectedRevision: i.ExpectedRevision})
		case "cancel":
			return mcpInvoke(b, cancelRecordingPreparationEndpoint(o.RecordingPreparations, o.TenantAuthz), recordingpreparation.Input{TenantID: b.tenant, SpaceID: spaceID, ExpectedRevision: i.ExpectedRevision})
		default:
			return nil, mcpError(apiErrorInvalidRequest)
		}
	})
}
