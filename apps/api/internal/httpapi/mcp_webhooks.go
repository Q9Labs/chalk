package httpapi

import (
	"context"
	"encoding/json"

	"github.com/q9labs/chalk/apps/api/internal/webhooks"
	mcpapi "github.com/q9labs/chalk/features/mcp/api"
)

func bindMCPWebhookTools(server *mcpapi.Server, o Options) {
	mcpapi.Bind(server, mcpapi.InspectWebhooks, func(ctx context.Context, i mcpapi.WebhookInspectInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		if i.EndpointID != "" {
			return mcpInvoke(b, getWebhookEndpoint(o.Webhooks, o.TenantAuthz), webhookIDsRequest{TenantID: b.tenant, EndpointID: b.id(i.EndpointID)})
		}
		return mcpInvoke(b, listWebhookEndpoints(o.Webhooks, o.TenantAuthz), listWebhooksRequest{TenantID: b.tenant, Page: b.page(i.PageInput)})
	})
	mcpapi.Bind(server, mcpapi.ConfigureWebhook, func(ctx context.Context, i mcpapi.WebhookChangeInput[createWebhookBody, patchWebhookBody, rotateWebhookBody]) (json.RawMessage, error) {
		scope := "webhooks:write"
		if i.Action == "delete" {
			scope = "webhooks:delete"
		}
		if err := mcpapi.RequireScope(ctx, scope); err != nil {
			return nil, err
		}
		b := newMCPRequest(ctx)
		switch i.Action {
		case "create":
			if !i.Create.Enabled.Set || i.Create.Enabled.Value == nil {
				b.err = apiErrorInvalidRequest
			}
			return mcpInvoke(b, createWebhookEndpoint(o.Webhooks, o.TenantAuthz), createWebhookRequest{TenantID: b.tenant, Key: i.RequestKey, Body: i.Create})
		case "update":
			if i.Revision < 1 || !i.Update.valid() {
				b.err = apiErrorInvalidRequest
			}
			return mcpInvoke(b, patchWebhookEndpoint(o.Webhooks, o.TenantAuthz), patchWebhookRequest{TenantID: b.tenant, EndpointID: b.id(i.EndpointID), Revision: i.Revision, Key: i.RequestKey, Body: i.Update})
		case "delete":
			if i.Revision < 1 {
				b.err = apiErrorInvalidRequest
			}
			return mcpInvoke(b, deleteWebhookEndpoint(o.Webhooks, o.TenantAuthz), deleteWebhookRequest{TenantID: b.tenant, EndpointID: b.id(i.EndpointID), Revision: i.Revision, Key: i.RequestKey})
		case "rotate_secret":
			if !i.Rotate.RevokePreviousImmediately.Set || i.Rotate.RevokePreviousImmediately.Value == nil {
				b.err = apiErrorInvalidRequest
			}
			return mcpInvoke(b, rotateWebhookSecretEndpoint(o.Webhooks, o.TenantAuthz), rotateWebhookRequest{TenantID: b.tenant, EndpointID: b.id(i.EndpointID), Key: i.RequestKey, Body: i.Rotate})
		default:
			return nil, mcpError(apiErrorInvalidRequest)
		}
	})
	mcpapi.Bind(server, mcpapi.InspectWebhookDeliveries, func(ctx context.Context, i mcpapi.WebhookDeliveriesInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		endpointID := b.id(i.EndpointID)
		if i.DeliveryID != "" {
			return mcpInvoke(b, getWebhookDeliveryEndpoint(o.Webhooks, o.TenantAuthz), webhookDeliveryIDsRequest{TenantID: b.tenant, EndpointID: endpointID, DeliveryID: b.id(i.DeliveryID)})
		}
		return mcpInvoke(b, listWebhookDeliveriesEndpoint(o.Webhooks, o.TenantAuthz), listWebhookDeliveriesRequest{TenantID: b.tenant, EndpointID: endpointID, Page: b.page(i.PageInput), Filters: webhooks.DeliveryFilters{States: i.States, EventTypes: i.EventTypes}})
	})
	mcpapi.Bind(server, mcpapi.SendWebhook, func(ctx context.Context, i mcpapi.WebhookSendInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		endpointID := b.id(i.EndpointID)
		switch i.Action {
		case "test":
			return mcpInvoke(b, testWebhookEndpoint(o.Webhooks, o.TenantAuthz), webhookActionRequest{TenantID: b.tenant, EndpointID: endpointID, Key: i.RequestKey})
		case "redeliver":
			return mcpInvoke(b, redeliverWebhookEndpoint(o.Webhooks, o.TenantAuthz), webhookDeliveryActionRequest{TenantID: b.tenant, EndpointID: endpointID, DeliveryID: b.id(i.DeliveryID), Key: i.RequestKey})
		default:
			return nil, mcpError(apiErrorInvalidRequest)
		}
	})
}
