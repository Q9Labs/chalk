package httpapi

import (
	"context"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/q9labs/chalk/apps/api/internal/mcptools"
)

func bindMCPTenantTools(server *mcp.Server, o Options) {
	mcptools.Bind(server, mcptools.GetConnection, func(ctx context.Context, _ mcptools.ReadInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		raw, err := mcpInvoke(b, getTenantEndpoint(o.Tenants, o.TenantAuthz), getTenantRequest{TenantID: b.tenant})
		if err != nil {
			return nil, err
		}
		var tenant tenantResponse
		if err := json.Unmarshal(raw, &tenant); err != nil {
			return nil, mcpError(apiErrorInternal)
		}
		return json.Marshal(mcptools.Profile{ID: mcptools.Connection(ctx).ProfileID, Name: tenant.Name})
	})
	bindMCPEndpoint(server, mcptools.UpdateTenant, updateTenantEndpoint(o.Tenants, o.TenantAuthz), func(b *mcpRequest, i mcptools.BodyInput[updateTenantRequest]) updateTenantEndpointRequest {
		return updateTenantEndpointRequest{TenantID: b.tenant, Body: i.Body}
	})
	mcptools.Bind(server, mcptools.InspectTenant, func(ctx context.Context, i mcptools.TenantViewInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		switch i.View {
		case "memberships":
			return mcpInvoke(b, listMembershipsEndpoint(o.Memberships, o.TenantAuthz), listMembershipsRequest{TenantID: b.tenant, Page: b.page(i.PageInput)})
		case "api_keys":
			return mcpInvoke(b, listAPIKeysEndpoint(o.APIKeys, o.TenantAuthz), listAPIKeysRequest{TenantID: b.tenant, Page: b.page(i.PageInput)})
		default:
			return mcpInvoke(b, getTenantEndpoint(o.Tenants, o.TenantAuthz), getTenantRequest{TenantID: b.tenant})
		}
	})
	mcptools.Bind(server, mcptools.SetMembership, func(ctx context.Context, i mcptools.MembershipInput[createMembershipRequest, updateMembershipRequest]) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		switch i.Action {
		case "create":
			return mcpInvoke(b, createMembershipEndpoint(o.Memberships, o.TenantAuthz), createMembershipEndpointRequest{TenantID: b.tenant, Body: i.Create})
		case "update":
			return mcpInvoke(b, updateMembershipEndpoint(o.Memberships, o.TenantAuthz), updateMembershipEndpointRequest{TenantID: b.tenant, MembershipID: b.id(i.MembershipID), Body: i.Update})
		default:
			return nil, mcpError(apiErrorInvalidRequest)
		}
	})
	mcptools.Bind(server, mcptools.IssueAPIKey, func(ctx context.Context, i mcptools.KeyInput[createAPIKeyBody, rotateAPIKeyBody]) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		switch i.Action {
		case "create":
			return mcpInvoke(b, createAPIKeyEndpoint(o.APIKeys, o.TenantAuthz), createAPIKeyRequest{TenantID: b.tenant, RequestKey: i.RequestKey, Body: i.Create})
		case "rotate":
			return mcpInvoke(b, rotateAPIKeyEndpoint(o.APIKeys, o.TenantAuthz), rotateAPIKeyRequest{apiKeyIDsRequest: apiKeyIDsRequest{TenantID: b.tenant, APIKeyID: b.id(i.APIKeyID)}, RequestKey: i.RequestKey, Body: i.Rotate})
		default:
			return nil, mcpError(apiErrorInvalidRequest)
		}
	})
	bindMCPEndpoint(server, mcptools.RevokeAPIKey, revokeAPIKeyEndpoint(o.APIKeys, o.TenantAuthz), func(b *mcpRequest, i mcptools.KeyIDInput) apiKeyIDsRequest {
		return apiKeyIDsRequest{TenantID: b.tenant, APIKeyID: b.id(i.APIKeyID)}
	})
}
