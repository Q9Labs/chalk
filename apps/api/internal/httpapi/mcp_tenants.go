package httpapi

import (
	"context"
	"encoding/json"

	mcpapi "github.com/q9labs/chalk/features/mcp/api"
)

func bindMCPTenantTools(server *mcpapi.Server, o Options) {
	mcpapi.Bind(server, mcpapi.WithResult[mcpapi.Profile](mcpapi.GetConnection), func(ctx context.Context, _ mcpapi.ReadInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		raw, err := mcpInvoke(b, getTenantEndpoint(o.Tenants, o.TenantAuthz), getTenantRequest{TenantID: b.tenant})
		if err != nil {
			return nil, err
		}
		var tenant tenantResponse
		if err := json.Unmarshal(raw, &tenant); err != nil {
			return nil, mcpError(apiErrorInternal)
		}
		return json.Marshal(mcpapi.Profile{ID: mcpapi.Connection(ctx).ProfileID, Name: tenant.Name})
	})
	bindMCPEndpoint(server, mcpapi.UpdateTenant, updateTenantEndpoint(o.Tenants, o.TenantAuthz), func(b *mcpRequest, i mcpapi.BodyInput[updateTenantRequest]) updateTenantEndpointRequest {
		return updateTenantEndpointRequest{TenantID: b.tenant, Body: i.Body}
	})
	bindMCPEndpoint(server, mcpapi.ListMemberships, listMembershipsEndpoint(o.Memberships, o.TenantAuthz), func(b *mcpRequest, i mcpapi.PageInput) listMembershipsRequest {
		return listMembershipsRequest{TenantID: b.tenant, Page: b.page(i)}
	})
	mcpapi.Bind(server, mcpapi.SetMembership, func(ctx context.Context, i mcpapi.MembershipInput[createMembershipRequest, updateMembershipRequest]) (json.RawMessage, error) {
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
	bindMCPEndpoint(server, mcpapi.ListAPIKeys, listAPIKeysEndpoint(o.APIKeys, o.TenantAuthz), func(b *mcpRequest, i mcpapi.PageInput) listAPIKeysRequest {
		return listAPIKeysRequest{TenantID: b.tenant, Page: b.page(i)}
	})
	mcpapi.Bind(server, mcpapi.IssueAPIKey, func(ctx context.Context, i mcpapi.KeyInput[createAPIKeyBody, rotateAPIKeyBody]) (json.RawMessage, error) {
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
	bindMCPEndpoint(server, mcpapi.RevokeAPIKey, revokeAPIKeyEndpoint(o.APIKeys, o.TenantAuthz), func(b *mcpRequest, i mcpapi.KeyIDInput) apiKeyIDsRequest {
		return apiKeyIDsRequest{TenantID: b.tenant, APIKeyID: b.id(i.APIKeyID)}
	})
}
