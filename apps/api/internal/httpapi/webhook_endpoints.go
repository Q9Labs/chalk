package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

type noResponse struct{}

func createWebhookEndpoint(service WebhookService, authorizer TenantAuthorizer) Endpoint[createWebhookRequest, webhookEndpointWithSecretResponse] {
	return Post("/v1/tenants/{tenant_id}/webhook-endpoints", "/tenants/{tenant_id}/webhook-endpoints", "createWebhookEndpoint", decodeCreateWebhookRequest, func(ctx context.Context, request createWebhookRequest) (webhookEndpointWithSecretResponse, error) {
		if service == nil {
			return webhookEndpointWithSecretResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeWebhooksPermission); err != nil {
			auditWebhookAuthorizationFailure(ctx, service, request.TenantID, "webhook_endpoint.create", "webhook_endpoint", utilities.ID{})
			return webhookEndpointWithSecretResponse{}, err
		}
		result, err := service.Create(ctx, webhooks.CreateInput{TenantID: request.TenantID, Name: request.Body.Name, URL: request.Body.URL, Enabled: *request.Body.Enabled.Value, APIVersion: request.Body.APIVersion, EventTypes: request.Body.EventTypes, CreatedByUserID: createdByUserID(ctx), IdempotencyKey: request.Key})
		if err != nil {
			return webhookEndpointWithSecretResponse{}, err
		}
		return newWebhookEndpointWithSecretResponse(result.Endpoint, result.Secret), nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), idempotencyKeyParameter()).RequestBody("CreateWebhookEndpointRequest", createWebhookContractBody{}).Responds(http.StatusCreated, "WebhookEndpointWithSecret", webhookEndpointWithSecretResponse{}).Errors(webhookWriteErrors()...).MapErrors(webhookAPIError)
}

func listWebhookEndpoints(service WebhookService, authorizer TenantAuthorizer) Endpoint[listWebhooksRequest, webhookEndpointListResponse] {
	return Get("/v1/tenants/{tenant_id}/webhook-endpoints", "/tenants/{tenant_id}/webhook-endpoints", "listWebhookEndpoints", decodeListWebhooksRequest, func(ctx context.Context, request listWebhooksRequest) (webhookEndpointListResponse, error) {
		if service == nil {
			return webhookEndpointListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readWebhooksPermission); err != nil {
			return webhookEndpointListResponse{}, err
		}
		list, err := service.List(ctx, request.TenantID, request.Page)
		if err != nil {
			return webhookEndpointListResponse{}, err
		}
		page, err := newWebhookPage(list.Page)
		if err != nil {
			return webhookEndpointListResponse{}, err
		}
		response := webhookEndpointListResponse{Endpoints: make([]webhookEndpointResponse, 0, len(list.Endpoints)), Page: page}
		for _, endpoint := range list.Endpoints {
			response.Endpoints = append(response.Endpoints, newWebhookEndpointResponse(endpoint))
		}
		return response, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(webhookReadRateLimit).Parameters(append([]APIParameterContract{tenantIDParameter()}, paginationParameters()...)...).Responds(http.StatusOK, "WebhookEndpointList", webhookEndpointListResponse{}).Errors(webhookReadErrors()...).MapErrors(webhookAPIError)
}

func getWebhookEndpoint(service WebhookService, authorizer TenantAuthorizer) Endpoint[webhookIDsRequest, webhookEndpointResponse] {
	return Get("/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}", "/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}", "getWebhookEndpoint", decodeWebhookIDsRequest, func(ctx context.Context, request webhookIDsRequest) (webhookEndpointResponse, error) {
		if service == nil {
			return webhookEndpointResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readWebhooksPermission); err != nil {
			return webhookEndpointResponse{}, err
		}
		value, err := service.Get(ctx, request.TenantID, request.EndpointID)
		return newWebhookEndpointResponse(value), err
	}).Auth(APIAuthSessionOrBearer).RateLimit(webhookReadRateLimit).Parameters(tenantIDParameter(), webhookEndpointIDParameter()).Responds(http.StatusOK, "WebhookEndpoint", webhookEndpointResponse{}).Errors(webhookReadErrors()...).MapErrors(webhookAPIError)
}

func patchWebhookEndpoint(service WebhookService, authorizer TenantAuthorizer) Endpoint[patchWebhookRequest, webhookEndpointResponse] {
	return Patch("/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}", "/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}", "updateWebhookEndpoint", decodePatchWebhookRequest, func(ctx context.Context, request patchWebhookRequest) (webhookEndpointResponse, error) {
		if service == nil {
			return webhookEndpointResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeWebhooksPermission); err != nil {
			action := "webhook_endpoint.update"
			if request.Body.Enabled.Set && request.Body.Enabled.Value != nil && !*request.Body.Enabled.Value {
				action = "webhook_endpoint.disable"
			}
			auditWebhookAuthorizationFailure(ctx, service, request.TenantID, action, "webhook_endpoint", request.EndpointID)
			return webhookEndpointResponse{}, err
		}
		value, err := service.Patch(ctx, request.TenantID, request.EndpointID, request.Body.toInput(request.Revision, request.Key))
		return newWebhookEndpointResponse(value), err
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), webhookEndpointIDParameter(), ifMatchParameter(), idempotencyKeyParameter()).RequestBody("UpdateWebhookEndpointRequest", patchWebhookContractBody{}).Responds(http.StatusOK, "WebhookEndpoint", webhookEndpointResponse{}).Errors(webhookWriteErrors()...).MapErrors(webhookAPIError)
}

func deleteWebhookEndpoint(service WebhookService, authorizer TenantAuthorizer) Endpoint[deleteWebhookRequest, noResponse] {
	return Delete("/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}", "/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}", "deleteWebhookEndpoint", decodeDeleteWebhookRequest, func(ctx context.Context, request deleteWebhookRequest) (noResponse, error) {
		if service == nil {
			return noResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, deleteWebhooksPermission); err != nil {
			auditWebhookAuthorizationFailure(ctx, service, request.TenantID, "webhook_endpoint.delete", "webhook_endpoint", request.EndpointID)
			return noResponse{}, err
		}
		return noResponse{}, service.Delete(ctx, request.TenantID, request.EndpointID, request.Revision, request.Key)
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), webhookEndpointIDParameter(), ifMatchParameter(), idempotencyKeyParameter()).RespondsNoBody(http.StatusNoContent).Errors(webhookWriteErrors()...).MapErrors(webhookAPIError)
}

func rotateWebhookSecretEndpoint(service WebhookService, authorizer TenantAuthorizer) Endpoint[rotateWebhookRequest, rotateWebhookSecretResponse] {
	return Post("/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/rotate-secret", "/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/rotate-secret", "rotateWebhookEndpointSecret", decodeRotateWebhookRequest, func(ctx context.Context, request rotateWebhookRequest) (rotateWebhookSecretResponse, error) {
		if service == nil {
			return rotateWebhookSecretResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeWebhooksPermission); err != nil {
			auditWebhookAuthorizationFailure(ctx, service, request.TenantID, "webhook_endpoint.rotate_secret", "webhook_endpoint", request.EndpointID)
			return rotateWebhookSecretResponse{}, err
		}
		value, err := service.RotateSecret(ctx, request.TenantID, request.EndpointID, *request.Body.RevokePreviousImmediately.Value, request.Key)
		return rotateWebhookSecretResponse{EndpointID: value.EndpointID.String(), Revision: value.Revision, Secret: value.Secret, PreviousSecretExpiresAt: responseTime(value.PreviousSecretExpiresAt)}, err
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), webhookEndpointIDParameter(), idempotencyKeyParameter()).RequestBody("RotateWebhookSecretRequest", rotateWebhookContractBody{}).Responds(http.StatusOK, "RotateWebhookSecretResponse", rotateWebhookSecretResponse{}).Errors(webhookWriteErrors()...).MapErrors(webhookAPIError)
}

func testWebhookEndpoint(service WebhookService, authorizer TenantAuthorizer) Endpoint[webhookActionRequest, webhookDeliveryCreatedResponse] {
	return Post("/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/test", "/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/test", "testWebhookEndpoint", decodeWebhookActionRequest, func(ctx context.Context, request webhookActionRequest) (webhookDeliveryCreatedResponse, error) {
		if service == nil {
			return webhookDeliveryCreatedResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeWebhooksPermission); err != nil {
			auditWebhookAuthorizationFailure(ctx, service, request.TenantID, "webhook_endpoint.test", "webhook_endpoint", request.EndpointID)
			return webhookDeliveryCreatedResponse{}, err
		}
		value, err := service.Test(ctx, request.TenantID, request.EndpointID, request.Key, webhooks.EventMetadata{})
		return newWebhookDeliveryCreatedResponse(value), err
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), webhookEndpointIDParameter(), idempotencyKeyParameter()).Responds(http.StatusCreated, "WebhookDeliveryCreated", webhookDeliveryCreatedResponse{}).Errors(webhookWriteErrors()...).MapErrors(webhookAPIError)
}

func listWebhookDeliveriesEndpoint(service WebhookService, authorizer TenantAuthorizer) Endpoint[listWebhookDeliveriesRequest, webhookDeliveryListResponse] {
	return Get("/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries", "/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries", "listWebhookDeliveries", decodeListWebhookDeliveriesRequest, func(ctx context.Context, request listWebhookDeliveriesRequest) (webhookDeliveryListResponse, error) {
		if service == nil {
			return webhookDeliveryListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readWebhooksPermission); err != nil {
			return webhookDeliveryListResponse{}, err
		}
		list, err := service.ListDeliveries(ctx, request.TenantID, request.EndpointID, request.Filters, request.Page)
		if err != nil {
			return webhookDeliveryListResponse{}, err
		}
		page, err := newWebhookPage(list.Page)
		if err != nil {
			return webhookDeliveryListResponse{}, err
		}
		response := webhookDeliveryListResponse{Deliveries: make([]webhookDeliveryResponse, 0, len(list.Deliveries)), Page: page}
		for _, delivery := range list.Deliveries {
			response.Deliveries = append(response.Deliveries, newWebhookDeliveryResponse(delivery))
		}
		return response, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(webhookReadRateLimit).Parameters(append(append([]APIParameterContract{tenantIDParameter(), webhookEndpointIDParameter()}, webhookDeliveryFilterParameters()...), paginationParameters()...)...).Responds(http.StatusOK, "WebhookDeliveryList", webhookDeliveryListResponse{}).Errors(webhookReadErrors()...).MapErrors(webhookAPIError)
}

func getWebhookDeliveryEndpoint(service WebhookService, authorizer TenantAuthorizer) Endpoint[webhookDeliveryIDsRequest, webhookDeliveryDetailResponse] {
	return Get("/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries/{delivery_id}", "/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries/{delivery_id}", "getWebhookDelivery", decodeWebhookDeliveryIDsRequest, func(ctx context.Context, request webhookDeliveryIDsRequest) (webhookDeliveryDetailResponse, error) {
		if service == nil {
			return webhookDeliveryDetailResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readWebhooksPermission); err != nil {
			return webhookDeliveryDetailResponse{}, err
		}
		detail, err := service.GetDelivery(ctx, request.TenantID, request.EndpointID, request.DeliveryID)
		if err != nil {
			return webhookDeliveryDetailResponse{}, err
		}
		return newWebhookDeliveryDetailResponse(detail), nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(webhookReadRateLimit).Parameters(tenantIDParameter(), webhookEndpointIDParameter(), webhookDeliveryIDParameter()).Responds(http.StatusOK, "WebhookDeliveryDetail", webhookDeliveryDetailResponse{}).Errors(webhookReadErrors()...).MapErrors(webhookAPIError)
}

func redeliverWebhookEndpoint(service WebhookService, authorizer TenantAuthorizer) Endpoint[webhookDeliveryActionRequest, webhookDeliveryCreatedResponse] {
	return Post("/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries/{delivery_id}/redeliver", "/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries/{delivery_id}/redeliver", "redeliverWebhookDelivery", decodeWebhookDeliveryActionRequest, func(ctx context.Context, request webhookDeliveryActionRequest) (webhookDeliveryCreatedResponse, error) {
		if service == nil {
			return webhookDeliveryCreatedResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeWebhooksPermission); err != nil {
			auditWebhookAuthorizationFailure(ctx, service, request.TenantID, "webhook_delivery.redeliver", "webhook_delivery", request.DeliveryID)
			return webhookDeliveryCreatedResponse{}, err
		}
		value, err := service.Redeliver(ctx, request.TenantID, request.EndpointID, request.DeliveryID, request.Key)
		return newWebhookDeliveryCreatedResponse(value), err
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), webhookEndpointIDParameter(), webhookDeliveryIDParameter(), idempotencyKeyParameter()).Responds(http.StatusCreated, "WebhookDeliveryCreated", webhookDeliveryCreatedResponse{}).Errors(webhookWriteErrors()...).MapErrors(webhookAPIError)
}

func auditWebhookAuthorizationFailure(ctx context.Context, service WebhookService, tenantID utilities.ID, action, resourceType string, resourceID utilities.ID) {
	service.AuditFailure(ctx, webhooks.FailureAuditInput{TenantID: tenantID, Action: action, ResourceType: resourceType, ResourceID: resourceID, ErrorCode: "forbidden"})
}
