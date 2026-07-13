package httpapi

import (
	"context"
	"encoding/json"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

var (
	readWebhooksPermission   = authorization.TenantPermission{Scope: authentication.ScopeWebhooksRead, MinimumRole: memberships.RoleAdmin}
	writeWebhooksPermission  = authorization.TenantPermission{Scope: authentication.ScopeWebhooksWrite, MinimumRole: memberships.RoleAdmin}
	deleteWebhooksPermission = authorization.TenantPermission{Scope: authentication.ScopeWebhooksDelete, MinimumRole: memberships.RoleAdmin}
)

type WebhookService interface {
	Create(context.Context, webhooks.CreateInput) (webhooks.CreateResult, error)
	Get(context.Context, utilities.ID, utilities.ID) (webhooks.Endpoint, error)
	List(context.Context, utilities.ID, pagination.PageRequest) (webhooks.EndpointList, error)
	Patch(context.Context, utilities.ID, utilities.ID, webhooks.PatchInput) (webhooks.Endpoint, error)
	Delete(context.Context, utilities.ID, utilities.ID, int, string) error
	RotateSecret(context.Context, utilities.ID, utilities.ID, bool, string) (webhooks.RotateResult, error)
	Test(context.Context, utilities.ID, utilities.ID, string, webhooks.EventMetadata) (webhooks.DeliveryResult, error)
	ListDeliveries(context.Context, utilities.ID, utilities.ID, webhooks.DeliveryFilters, pagination.PageRequest) (webhooks.DeliveryList, error)
	GetDelivery(context.Context, utilities.ID, utilities.ID, utilities.ID) (webhooks.DeliveryDetail, error)
	Redeliver(context.Context, utilities.ID, utilities.ID, utilities.ID, string) (webhooks.DeliveryResult, error)
	AuditFailure(context.Context, webhooks.FailureAuditInput)
}

type webhookEndpointResponse struct {
	ID          string   `json:"id"`
	TenantID    string   `json:"tenant_id"`
	Name        string   `json:"name"`
	URLRedacted string   `json:"url_redacted"`
	Enabled     bool     `json:"enabled"`
	Revision    int      `json:"revision"`
	APIVersion  int      `json:"api_version"`
	EventTypes  []string `json:"event_types"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
}
type webhookEndpointWithSecretResponse struct {
	ID          string   `json:"id"`
	TenantID    string   `json:"tenant_id"`
	Name        string   `json:"name"`
	URLRedacted string   `json:"url_redacted"`
	Enabled     bool     `json:"enabled"`
	Revision    int      `json:"revision"`
	APIVersion  int      `json:"api_version"`
	EventTypes  []string `json:"event_types"`
	Secret      string   `json:"secret"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
}
type webhookPageResponse struct {
	NextCursor *string `json:"next_cursor"`
}
type webhookEndpointListResponse struct {
	Endpoints []webhookEndpointResponse `json:"webhook_endpoints"`
	Page      webhookPageResponse       `json:"page"`
}
type webhookDeliveryResponse struct {
	ID               string  `json:"id"`
	EventID          string  `json:"event_id"`
	EventType        string  `json:"event_type"`
	EndpointID       string  `json:"endpoint_id"`
	EndpointRevision int     `json:"endpoint_revision"`
	State            string  `json:"state"`
	AttemptCount     int     `json:"attempt_count"`
	NextAttemptAt    *string `json:"next_attempt_at"`
	TerminalAt       *string `json:"terminal_at"`
	CreatedAt        string  `json:"created_at"`
	UpdatedAt        string  `json:"updated_at"`
}
type webhookDeliveryListResponse struct {
	Deliveries []webhookDeliveryResponse `json:"deliveries"`
	Page       webhookPageResponse       `json:"page"`
}
type webhookAttemptResponse struct {
	ID                  string  `json:"id"`
	Number              int     `json:"number"`
	StartedAt           string  `json:"started_at"`
	FinishedAt          *string `json:"finished_at"`
	LatencyMilliseconds *int    `json:"latency_milliseconds"`
	Outcome             string  `json:"outcome"`
	HTTPStatus          *int    `json:"http_status"`
	ErrorCode           *string `json:"error_code"`
}
type webhookDeliveryDetailResponse struct {
	ID               string                   `json:"id"`
	EventID          string                   `json:"event_id"`
	EventType        string                   `json:"event_type"`
	EndpointID       string                   `json:"endpoint_id"`
	EndpointRevision int                      `json:"endpoint_revision"`
	State            string                   `json:"state"`
	AttemptCount     int                      `json:"attempt_count"`
	NextAttemptAt    *string                  `json:"next_attempt_at"`
	TerminalAt       *string                  `json:"terminal_at"`
	CreatedAt        string                   `json:"created_at"`
	UpdatedAt        string                   `json:"updated_at"`
	Event            json.RawMessage          `json:"event"`
	Attempts         []webhookAttemptResponse `json:"attempts"`
}
type webhookDeliveryCreatedResponse struct {
	EventID          string `json:"event_id"`
	DeliveryID       string `json:"delivery_id"`
	EndpointID       string `json:"endpoint_id"`
	EndpointRevision int    `json:"endpoint_revision"`
	State            string `json:"state"`
}
type rotateWebhookSecretResponse struct {
	EndpointID              string  `json:"endpoint_id"`
	Revision                int     `json:"revision"`
	Secret                  string  `json:"secret"`
	PreviousSecretExpiresAt *string `json:"previous_secret_expires_at"`
}

func mountWebhookRoutes(r chi.Router, service WebhookService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range webhookEndpoints(service, authorizer) {
		endpoint.Mount(r, limits)
	}
}
func webhookEndpoints(service WebhookService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{createWebhookEndpoint(service, authorizer), listWebhookEndpoints(service, authorizer), getWebhookEndpoint(service, authorizer), patchWebhookEndpoint(service, authorizer), deleteWebhookEndpoint(service, authorizer), rotateWebhookSecretEndpoint(service, authorizer), testWebhookEndpoint(service, authorizer), listWebhookDeliveriesEndpoint(service, authorizer), getWebhookDeliveryEndpoint(service, authorizer), redeliverWebhookEndpoint(service, authorizer)}
}

func newWebhookEndpointResponse(endpoint webhooks.Endpoint) webhookEndpointResponse {
	return webhookEndpointResponse{ID: endpoint.ID.String(), TenantID: endpoint.TenantID.String(), Name: endpoint.Name, URLRedacted: endpoint.URLRedacted, Enabled: endpoint.Enabled, Revision: endpoint.Revision, APIVersion: endpoint.APIVersion, EventTypes: endpoint.EventTypes, CreatedAt: endpoint.CreatedAt.UTC().Format(time.RFC3339Nano), UpdatedAt: endpoint.UpdatedAt.UTC().Format(time.RFC3339Nano)}
}
func newWebhookEndpointWithSecretResponse(endpoint webhooks.Endpoint, secret string) webhookEndpointWithSecretResponse {
	return webhookEndpointWithSecretResponse{ID: endpoint.ID.String(), TenantID: endpoint.TenantID.String(), Name: endpoint.Name, URLRedacted: endpoint.URLRedacted, Enabled: endpoint.Enabled, Revision: endpoint.Revision, APIVersion: endpoint.APIVersion, EventTypes: endpoint.EventTypes, Secret: secret, CreatedAt: endpoint.CreatedAt.UTC().Format(time.RFC3339Nano), UpdatedAt: endpoint.UpdatedAt.UTC().Format(time.RFC3339Nano)}
}
func newWebhookPage(page pagination.Page) (webhookPageResponse, error) {
	if page.NextCursor == nil {
		return webhookPageResponse{}, nil
	}
	cursor, err := pagination.EncodeCursor(*page.NextCursor)
	if err != nil {
		return webhookPageResponse{}, err
	}
	return webhookPageResponse{NextCursor: &cursor}, nil
}
func newWebhookDeliveryResponse(value webhooks.Delivery) webhookDeliveryResponse {
	return webhookDeliveryResponse{ID: value.ID.String(), EventID: value.EventID.String(), EventType: value.EventType, EndpointID: value.EndpointID.String(), EndpointRevision: value.EndpointRevision, State: value.State, AttemptCount: value.AttemptCount, NextAttemptAt: responseTime(value.NextAttemptAt), TerminalAt: responseTime(value.TerminalAt), CreatedAt: value.CreatedAt.UTC().Format(time.RFC3339Nano), UpdatedAt: value.UpdatedAt.UTC().Format(time.RFC3339Nano)}
}
func newWebhookDeliveryDetailResponse(value webhooks.DeliveryDetail) webhookDeliveryDetailResponse {
	delivery := newWebhookDeliveryResponse(value.Delivery)
	response := webhookDeliveryDetailResponse{ID: delivery.ID, EventID: delivery.EventID, EventType: delivery.EventType, EndpointID: delivery.EndpointID, EndpointRevision: delivery.EndpointRevision, State: delivery.State, AttemptCount: delivery.AttemptCount, NextAttemptAt: delivery.NextAttemptAt, TerminalAt: delivery.TerminalAt, CreatedAt: delivery.CreatedAt, UpdatedAt: delivery.UpdatedAt, Event: value.Event, Attempts: make([]webhookAttemptResponse, 0, len(value.Attempts))}
	for _, attempt := range value.Attempts {
		response.Attempts = append(response.Attempts, webhookAttemptResponse{ID: attempt.ID.String(), Number: attempt.Number, StartedAt: attempt.StartedAt.UTC().Format(time.RFC3339Nano), FinishedAt: responseTime(attempt.FinishedAt), LatencyMilliseconds: attempt.LatencyMilliseconds, Outcome: attempt.Outcome, HTTPStatus: attempt.HTTPStatus, ErrorCode: attempt.ErrorCode})
	}
	return response
}
func responseTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}
func newWebhookDeliveryCreatedResponse(value webhooks.DeliveryResult) webhookDeliveryCreatedResponse {
	return webhookDeliveryCreatedResponse{EventID: value.EventID.String(), DeliveryID: value.DeliveryID.String(), EndpointID: value.EndpointID.String(), EndpointRevision: value.EndpointRevision, State: value.State}
}
