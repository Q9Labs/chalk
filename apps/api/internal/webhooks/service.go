package webhooks

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"regexp"
	"sort"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

type Service struct {
	repository Repository
	protector  SecretProtector
}

func NewService(repository Repository, protector SecretProtector) Service {
	return Service{repository: repository, protector: protector}
}

func (s Service) Create(ctx context.Context, input CreateInput) (result CreateResult, resultErr error) {
	defer func() {
		s.auditFailure(ctx, input.TenantID, "webhook_endpoint.create", "webhook_endpoint", utilities.ID{}, resultErr)
	}()
	if err := validateCreateInput(&input); err != nil {
		return CreateResult{}, err
	}
	return s.repository.Create(ctx, input)
}

func (s Service) Get(ctx context.Context, tenantID, endpointID utilities.ID) (Endpoint, error) {
	if tenantID.IsZero() {
		return Endpoint{}, ErrInvalidTenantID
	}
	if endpointID.IsZero() {
		return Endpoint{}, ErrInvalidEndpointID
	}
	return s.repository.Get(ctx, tenantID, endpointID)
}

func (s Service) List(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (EndpointList, error) {
	if tenantID.IsZero() {
		return EndpointList{}, ErrInvalidTenantID
	}
	return s.repository.List(ctx, tenantID, page)
}

func (s Service) Patch(ctx context.Context, tenantID, endpointID utilities.ID, input PatchInput) (result Endpoint, resultErr error) {
	defer func() {
		action := "webhook_endpoint.update"
		if input.Enabled != nil && !*input.Enabled {
			action = "webhook_endpoint.disable"
		}
		s.auditFailure(ctx, tenantID, action, "webhook_endpoint", endpointID, resultErr)
	}()
	if tenantID.IsZero() {
		return Endpoint{}, ErrInvalidTenantID
	}
	if endpointID.IsZero() {
		return Endpoint{}, ErrInvalidEndpointID
	}
	if input.ExpectedRevision < 1 {
		return Endpoint{}, ErrRevisionConflict
	}
	if !idempotencyKeyPattern.MatchString(input.IdempotencyKey) {
		return Endpoint{}, ErrIdempotencyKeyRequired
	}
	if input.Name == nil && input.URL == nil && input.Enabled == nil && input.APIVersion == nil && input.EventTypes == nil {
		return Endpoint{}, ErrInvalidPatch
	}
	if input.Name != nil && (len([]rune(strings.TrimSpace(*input.Name))) < 1 || len([]rune(strings.TrimSpace(*input.Name))) > 100) {
		return Endpoint{}, ErrInvalidName
	}
	if input.Name != nil {
		trimmed := strings.TrimSpace(*input.Name)
		*input.Name = trimmed
	}
	var normalizedURL string
	var redactedURL string
	if input.URL != nil {
		parsed, redacted, err := ValidateEndpointURL(*input.URL)
		if err != nil {
			return Endpoint{}, err
		}
		*input.URL = parsed
		redactedURL = redacted
		normalizedURL = parsed
	}
	if input.APIVersion != nil && *input.APIVersion != APIVersion {
		return Endpoint{}, ErrInvalidAPIVersion
	}
	if input.EventTypes != nil {
		eventTypes, err := validateEventTypes(*input.EventTypes)
		if err != nil {
			return Endpoint{}, err
		}
		*input.EventTypes = eventTypes
	}
	return s.repository.Patch(ctx, tenantID, endpointID, input, normalizedURL, redactedURL)
}

func (s Service) Delete(ctx context.Context, tenantID, endpointID utilities.ID, revision int, key string) (resultErr error) {
	defer func() {
		s.auditFailure(ctx, tenantID, "webhook_endpoint.delete", "webhook_endpoint", endpointID, resultErr)
	}()
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if endpointID.IsZero() {
		return ErrInvalidEndpointID
	}
	if revision < 1 {
		return ErrRevisionConflict
	}
	if !idempotencyKeyPattern.MatchString(key) {
		return ErrIdempotencyKeyRequired
	}
	return s.repository.Delete(ctx, tenantID, endpointID, revision, key)
}

func (s Service) RotateSecret(ctx context.Context, tenantID, endpointID utilities.ID, immediate bool, key string) (result RotateResult, resultErr error) {
	defer func() {
		s.auditFailure(ctx, tenantID, "webhook_endpoint.rotate_secret", "webhook_endpoint", endpointID, resultErr)
	}()
	if tenantID.IsZero() {
		return RotateResult{}, ErrInvalidTenantID
	}
	if endpointID.IsZero() {
		return RotateResult{}, ErrInvalidEndpointID
	}
	if !idempotencyKeyPattern.MatchString(key) {
		return RotateResult{}, ErrIdempotencyKeyRequired
	}
	return s.repository.RotateSecret(ctx, tenantID, endpointID, immediate, key)
}

func (s Service) Test(ctx context.Context, tenantID, endpointID utilities.ID, key string, metadata EventMetadata) (result DeliveryResult, resultErr error) {
	defer func() {
		s.auditFailure(ctx, tenantID, "webhook_endpoint.test", "webhook_endpoint", endpointID, resultErr)
	}()
	if tenantID.IsZero() {
		return DeliveryResult{}, ErrInvalidTenantID
	}
	if endpointID.IsZero() {
		return DeliveryResult{}, ErrInvalidEndpointID
	}
	if !idempotencyKeyPattern.MatchString(key) {
		return DeliveryResult{}, ErrIdempotencyKeyRequired
	}
	return s.repository.Test(ctx, tenantID, endpointID, key, metadata)
}

func (s Service) ListDeliveries(ctx context.Context, tenantID, endpointID utilities.ID, filters DeliveryFilters, page pagination.PageRequest) (DeliveryList, error) {
	if tenantID.IsZero() {
		return DeliveryList{}, ErrInvalidTenantID
	}
	if endpointID.IsZero() {
		return DeliveryList{}, ErrInvalidEndpointID
	}
	if err := validateDeliveryFilters(filters); err != nil {
		return DeliveryList{}, err
	}
	return s.repository.ListDeliveries(ctx, tenantID, endpointID, filters, page)
}
func (s Service) GetDelivery(ctx context.Context, tenantID, endpointID, deliveryID utilities.ID) (DeliveryDetail, error) {
	if tenantID.IsZero() {
		return DeliveryDetail{}, ErrInvalidTenantID
	}
	if endpointID.IsZero() {
		return DeliveryDetail{}, ErrInvalidEndpointID
	}
	if deliveryID.IsZero() {
		return DeliveryDetail{}, ErrInvalidDeliveryID
	}
	return s.repository.GetDelivery(ctx, tenantID, endpointID, deliveryID)
}
func (s Service) Redeliver(ctx context.Context, tenantID, endpointID, deliveryID utilities.ID, key string) (result DeliveryResult, resultErr error) {
	defer func() { RecordRedeliveryResult(ctx, redeliveryMetricOutcome(resultErr)) }()
	defer func() {
		s.auditFailure(ctx, tenantID, "webhook_delivery.redeliver", "webhook_delivery", deliveryID, resultErr)
	}()
	if tenantID.IsZero() {
		return DeliveryResult{}, ErrInvalidTenantID
	}
	if endpointID.IsZero() {
		return DeliveryResult{}, ErrInvalidEndpointID
	}
	if deliveryID.IsZero() {
		return DeliveryResult{}, ErrInvalidDeliveryID
	}
	if !idempotencyKeyPattern.MatchString(key) {
		return DeliveryResult{}, ErrIdempotencyKeyRequired
	}
	return s.repository.Redeliver(ctx, tenantID, endpointID, deliveryID, key)
}

func (s Service) AuditFailure(ctx context.Context, input FailureAuditInput) {
	if input.TenantID.IsZero() || input.ErrorCode == "" {
		return
	}
	if auditor, ok := s.repository.(FailureAuditor); ok {
		_ = auditor.RecordWebhookFailure(ctx, input)
	}
}

func (s Service) auditFailure(ctx context.Context, tenantID utilities.ID, action, resourceType string, resourceID utilities.ID, err error) {
	if err == nil {
		return
	}
	s.AuditFailure(ctx, FailureAuditInput{TenantID: tenantID, Action: action, ResourceType: resourceType, ResourceID: resourceID, ErrorCode: webhookAuditErrorCode(err)})
}

func webhookAuditErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrRevisionConflict):
		return "revision_conflict"
	case errors.Is(err, ErrIdempotencyKeyConflict):
		return "idempotency_key_conflict"
	case errors.Is(err, ErrIdempotencyKeyExpired):
		return "idempotency_key_expired"
	case errors.Is(err, ErrIdempotencyKeyRequired):
		return "idempotency_key_required"
	case errors.Is(err, ErrEndpointNotFound), errors.Is(err, ErrDeliveryNotFound):
		return "not_found"
	case errors.Is(err, ErrDeliveryNotRedeliverable):
		return "not_redeliverable"
	case errors.Is(err, ErrEventErased):
		return "event_erased"
	case errors.Is(err, ErrEncryptionUnavailable):
		return "encryption_unavailable"
	default:
		return "invalid_request"
	}
}

func redeliveryMetricOutcome(err error) string {
	switch {
	case err == nil:
		return "accepted"
	case errors.Is(err, ErrEndpointNotFound), errors.Is(err, ErrDeliveryNotFound):
		return "not_found"
	case errors.Is(err, ErrDeliveryNotRedeliverable):
		return "not_redeliverable"
	case errors.Is(err, ErrEventErased):
		return "erased"
	case errors.Is(err, ErrIdempotencyKeyConflict), errors.Is(err, ErrIdempotencyKeyExpired):
		return "conflict"
	default:
		return "failed"
	}
}

func validateDeliveryFilters(filters DeliveryFilters) error {
	states := map[string]struct{}{"pending": {}, "retry_wait": {}, "delivering": {}, "succeeded": {}, "exhausted": {}, "canceled": {}, "erased": {}}
	events := map[string]struct{}{"endpoint.test": {}}
	for _, value := range CoreEventTypes {
		events[value] = struct{}{}
	}
	for value := range reservedEventTypes {
		events[value] = struct{}{}
	}
	for _, value := range filters.States {
		if _, ok := states[value]; !ok {
			return ErrInvalidDeliveryFilter
		}
	}
	for _, value := range filters.EventTypes {
		if _, ok := events[value]; !ok {
			return ErrInvalidDeliveryFilter
		}
	}
	return nil
}

func validateCreateInput(input *CreateInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	input.Name = strings.TrimSpace(input.Name)
	if len([]rune(input.Name)) < 1 || len([]rune(input.Name)) > 100 {
		return ErrInvalidName
	}
	parsed, _, err := ValidateEndpointURL(input.URL)
	if err != nil {
		return err
	}
	input.URL = parsed
	if input.APIVersion != APIVersion {
		return ErrInvalidAPIVersion
	}
	input.EventTypes, err = validateEventTypes(input.EventTypes)
	if err != nil {
		return err
	}
	if !idempotencyKeyPattern.MatchString(input.IdempotencyKey) {
		return ErrIdempotencyKeyRequired
	}
	return nil
}

func validateEventTypes(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, ErrInvalidEventType
	}
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, reserved := reservedEventTypes[value]; reserved {
			return nil, ErrEventTypeUnavailable
		}
		found := false
		for _, allowed := range CoreEventTypes {
			if value == allowed {
				found = true
				break
			}
		}
		if !found {
			return nil, ErrInvalidEventType
		}
		set[value] = struct{}{}
	}
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}

func NewSigningSecret() (string, []byte, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	return "whsec_" + base64.StdEncoding.EncodeToString(raw), raw, nil
}
