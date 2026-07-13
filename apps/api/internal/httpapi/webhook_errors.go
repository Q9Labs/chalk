package httpapi

import (
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func webhookReadErrors() []APIError {
	return []APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantID, apiErrorInvalidWebhookEndpointID, apiErrorInvalidWebhookDeliveryID, apiErrorWebhookEndpointNotFound, apiErrorWebhookDeliveryNotFound, apiErrorWebhookEventErased, apiErrorInvalidPageSize, apiErrorInvalidCursor, apiErrorRateLimited, apiErrorInternal}
}
func webhookWriteErrors() []APIError {
	return append(webhookReadErrors(), apiErrorInvalidRequest, apiErrorInvalidWebhookURL, apiErrorUnsafeWebhookURL, apiErrorInvalidWebhookEventType, apiErrorWebhookEventTypeUnavailable, apiErrorInvalidWebhookAPIVersion, apiErrorWebhookEndpointLimit, apiErrorWebhookDeliveryNotRedeliverable, apiErrorWebhookRevisionConflict, apiErrorWebhookIdempotencyRequired, apiErrorWebhookIdempotencyConflict, apiErrorWebhookIdempotencyExpired)
}

func webhookAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, webhooks.ErrInvalidEndpointID):
		return apiErrorInvalidWebhookEndpointID, true
	case errors.Is(err, webhooks.ErrInvalidDeliveryID):
		return apiErrorInvalidWebhookDeliveryID, true
	case errors.Is(err, webhooks.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, webhooks.ErrInvalidName), errors.Is(err, webhooks.ErrInvalidPatch), errors.Is(err, webhooks.ErrInvalidDeliveryFilter):
		return apiErrorInvalidRequest, true
	case errors.Is(err, webhooks.ErrInvalidURL):
		return apiErrorInvalidWebhookURL, true
	case errors.Is(err, webhooks.ErrUnsafeURL):
		return apiErrorUnsafeWebhookURL, true
	case errors.Is(err, webhooks.ErrInvalidEventType):
		return apiErrorInvalidWebhookEventType, true
	case errors.Is(err, webhooks.ErrEventTypeUnavailable):
		return apiErrorWebhookEventTypeUnavailable, true
	case errors.Is(err, webhooks.ErrInvalidAPIVersion):
		return apiErrorInvalidWebhookAPIVersion, true
	case errors.Is(err, webhooks.ErrEndpointLimitReached):
		return apiErrorWebhookEndpointLimit, true
	case errors.Is(err, webhooks.ErrEndpointNotFound):
		return apiErrorWebhookEndpointNotFound, true
	case errors.Is(err, webhooks.ErrDeliveryNotFound):
		return apiErrorWebhookDeliveryNotFound, true
	case errors.Is(err, webhooks.ErrDeliveryNotRedeliverable):
		return apiErrorWebhookDeliveryNotRedeliverable, true
	case errors.Is(err, webhooks.ErrEventErased):
		return apiErrorWebhookEventErased, true
	case errors.Is(err, webhooks.ErrRevisionConflict):
		return apiErrorWebhookRevisionConflict, true
	case errors.Is(err, webhooks.ErrIdempotencyKeyRequired):
		return apiErrorWebhookIdempotencyRequired, true
	case errors.Is(err, webhooks.ErrIdempotencyKeyConflict):
		return apiErrorWebhookIdempotencyConflict, true
	case errors.Is(err, webhooks.ErrIdempotencyKeyExpired):
		return apiErrorWebhookIdempotencyExpired, true
	default:
		return authorizationAPIError(err), true
	}
}
