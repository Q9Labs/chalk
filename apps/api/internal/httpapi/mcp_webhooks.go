package httpapi

import (
	"context"
	"encoding/json"

	"github.com/q9labs/chalk/apps/api/internal/mcptools"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func bindMCPWebhookTools(registry *mcptools.Registry, o Options) {
	mcptools.Bind(registry, mcptools.InspectWebhooks, func(ctx context.Context, i mcptools.WebhooksViewInput) (json.RawMessage, error) {
		b := newMCPRequest(ctx)
		switch i.View {
		case "endpoint":
			return mcpInvoke(b, getWebhookEndpoint(o.Webhooks, o.TenantAuthz), webhookIDsRequest{TenantID: b.tenant, EndpointID: b.id(i.EndpointID)})
		case "deliveries":
			return mcpInvoke(b, listWebhookDeliveriesEndpoint(o.Webhooks, o.TenantAuthz), listWebhookDeliveriesRequest{TenantID: b.tenant, EndpointID: b.id(i.EndpointID), Page: b.page(i.PageInput), Filters: webhooks.DeliveryFilters{States: i.States, EventTypes: i.EventTypes}})
		case "delivery":
			return mcpInvoke(b, getWebhookDeliveryEndpoint(o.Webhooks, o.TenantAuthz), webhookDeliveryIDsRequest{TenantID: b.tenant, EndpointID: b.id(i.EndpointID), DeliveryID: b.id(i.DeliveryID)})
		default:
			return mcpInvoke(b, listWebhookEndpoints(o.Webhooks, o.TenantAuthz), listWebhooksRequest{TenantID: b.tenant, Page: b.page(i.PageInput)})
		}
	})
	mcptools.Bind(registry, mcptools.ConfigureWebhook, func(ctx context.Context, i mcptools.WebhookChangeInput[createWebhookBody, patchWebhookBody, rotateWebhookBody]) (json.RawMessage, error) {
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
	mcptools.Bind(registry, mcptools.SendWebhook, func(ctx context.Context, i mcptools.WebhookSendInput) (json.RawMessage, error) {
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
