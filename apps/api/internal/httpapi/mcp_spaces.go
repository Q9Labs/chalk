package httpapi

import (
	"context"
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mcptools"
	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
)

func bindMCPSpaceTools(registry *mcptools.Registry, o Options) {
	mcptools.Bind(registry, mcptools.InspectSpaces, func(ctx context.Context, i mcptools.SpacesViewInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		switch i.View {
		case "settings":
			return mcpInvoke(b, getSpaceEndpoint(o.Spaces, o.TenantAuthz), getSpaceRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID)})
		case "invite":
			return mcpInvoke(b, getSpacePublicInviteEndpoint(o.PublicInvites, o.TenantAuthz), publicInvitePathRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID)})
		default:
			return mcpInvoke(b, listSpacesEndpoint(o.Spaces, o.TenantAuthz), listSpacesRequest{TenantID: b.tenant, Page: b.page(i.PageInput), Archived: i.Archived})
		}
	})
	bindMCPEndpoint(registry, mcptools.CreateSpace, createSpaceEndpoint(o.Spaces, o.TenantAuthz), func(b *mcpRequest, i mcptools.BodyInput[createSpaceRequest]) createSpaceEndpointRequest {
		return createSpaceEndpointRequest{TenantID: b.tenant, RequestKey: i.RequestKey, Body: i.Body}
	})
	mcptools.Bind(registry, mcptools.ConfigureSpace, func(ctx context.Context, i mcptools.SpaceChangeInput[updateSpaceRequest]) (json.RawMessage, error) {
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
	mcptools.Bind(registry, mcptools.SetSpaceArchived, func(ctx context.Context, i mcptools.ArchiveInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		request := getSpaceRequest{TenantID: b.tenant, SpaceID: b.id(i.SpaceID)}
		if i.Archived {
			return mcpInvoke(b, archiveSpaceEndpoint(o.Spaces, o.TenantAuthz), request)
		}
		return mcpInvoke(b, restoreSpaceEndpoint(o.Spaces, o.TenantAuthz), request)
	})
	mcptools.Bind(registry, mcptools.PrepareRecording, func(ctx context.Context, i mcptools.PreparationInput) (json.RawMessage, error) {
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
