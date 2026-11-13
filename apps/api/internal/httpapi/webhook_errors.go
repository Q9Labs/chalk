package httpapi

import (
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func webhookReadErrors() []APIError {
	return []APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantID, apiErrorInvalidWebhookEndpointID, apiErrorInvalidWebhookDeliveryID, apiErrorWebhookEndpointNotFound, apiErrorWebhookDeliveryNotFound, apiErrorWebhookEventErased, apiErrorInvalidPageSize, apiErrorInvalidCursor, apiErrorRateLimited, apiErrorInternal}
}
func webhookWriteErrors() []APIError {
	return append(webhookReadErrors(), apiErrorInvalidRequest, apiErrorInvalidWebhookURL, apiErrorUnsafeWebhookURL, apiErrorInvalidWebhookEventType, apiErrorWebhookEventTypeUnavailable, apiErrorInvalidWebhookAPIVersion, apiErrorWebhookEndpointLimit, apiErrorWebhookDeliveryNotRedeliverable, apiErrorWebhookRevisionConflict, apiErrorWebhookIdempotencyRequired, apiErrorWebhookIdempotencyConflict, apiErrorWebhookIdempotencyExpired)
}

var webhookRules = errorRules{
	ruleFor(apiErrorInvalidWebhookEndpointID, webhooks.ErrInvalidEndpointID),
	ruleFor(apiErrorInvalidWebhookDeliveryID, webhooks.ErrInvalidDeliveryID),
	ruleFor(apiErrorInvalidTenantID, webhooks.ErrInvalidTenantID),
	ruleFor(apiErrorInvalidRequest, webhooks.ErrInvalidName, webhooks.ErrInvalidPatch, webhooks.ErrInvalidDeliveryFilter),
	ruleFor(apiErrorInvalidWebhookURL, webhooks.ErrInvalidURL),
	ruleFor(apiErrorUnsafeWebhookURL, webhooks.ErrUnsafeURL),
	ruleFor(apiErrorInvalidWebhookEventType, webhooks.ErrInvalidEventType),
	ruleFor(apiErrorWebhookEventTypeUnavailable, webhooks.ErrEventTypeUnavailable),
	ruleFor(apiErrorInvalidWebhookAPIVersion, webhooks.ErrInvalidAPIVersion),
	ruleFor(apiErrorWebhookEndpointLimit, webhooks.ErrEndpointLimitReached),
	ruleFor(apiErrorWebhookEndpointNotFound, webhooks.ErrEndpointNotFound),
	ruleFor(apiErrorWebhookDeliveryNotFound, webhooks.ErrDeliveryNotFound),
	ruleFor(apiErrorWebhookDeliveryNotRedeliverable, webhooks.ErrDeliveryNotRedeliverable),
	ruleFor(apiErrorWebhookEventErased, webhooks.ErrEventErased),
	ruleFor(apiErrorWebhookRevisionConflict, webhooks.ErrRevisionConflict),
	ruleFor(apiErrorWebhookIdempotencyRequired, webhooks.ErrIdempotencyKeyRequired),
	ruleFor(apiErrorWebhookIdempotencyConflict, webhooks.ErrIdempotencyKeyConflict),
	ruleFor(apiErrorWebhookIdempotencyExpired, webhooks.ErrIdempotencyKeyExpired),
}
