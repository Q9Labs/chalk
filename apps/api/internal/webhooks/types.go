package webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	APIVersion            = 1
	MaxEndpointsPerTenant = 10
	MaxBodyBytes          = 256 << 10
	MaxResponseBytes      = 64 << 10
)

var (
	ErrInvalidEndpointID        = errors.New("invalid webhook endpoint id")
	ErrInvalidDeliveryID        = errors.New("invalid webhook delivery id")
	ErrInvalidTenantID          = errors.New("invalid tenant id")
	ErrInvalidName              = errors.New("invalid webhook endpoint name")
	ErrInvalidURL               = errors.New("invalid webhook url")
	ErrUnsafeURL                = errors.New("unsafe webhook url")
	ErrInvalidEventType         = errors.New("invalid webhook event type")
	ErrEventTypeUnavailable     = errors.New("webhook event type unavailable")
	ErrInvalidAPIVersion        = errors.New("invalid webhook api version")
	ErrEndpointLimitReached     = errors.New("webhook endpoint limit reached")
	ErrEndpointNotFound         = errors.New("webhook endpoint not found")
	ErrDeliveryNotFound         = errors.New("webhook delivery not found")
	ErrDeliveryNotRedeliverable = errors.New("webhook delivery not redeliverable")
	ErrDeliveryLeaseLost        = errors.New("webhook delivery lease lost")
	ErrEventErased              = errors.New("webhook event erased")
	ErrRevisionConflict         = errors.New("webhook endpoint revision conflict")
	ErrIdempotencyKeyRequired   = errors.New("idempotency key required")
	ErrIdempotencyKeyConflict   = errors.New("idempotency key conflict")
	ErrIdempotencyKeyExpired    = errors.New("idempotency key expired")
	ErrInvalidPatch             = errors.New("invalid webhook endpoint patch")
	ErrInvalidDeliveryFilter    = errors.New("invalid webhook delivery filter")
	ErrEncryptionUnavailable    = errors.New("webhook encryption unavailable")
)

var CoreEventTypes = []string{
	"participant.joined", "participant.left", "room.archived", "room.created",
	"room.restored", "room.updated", "session.ended", "session.started",
}

var reservedEventTypes = map[string]struct{}{
	"recording.started": {}, "recording.completed": {}, "recording.failed": {},
	"transcript.started": {}, "transcript.completed": {}, "transcript.failed": {},
}

type Endpoint struct {
	ID          utilities.ID
	TenantID    utilities.ID
	Name        string
	URLRedacted string
	Enabled     bool
	Revision    int
	APIVersion  int
	EventTypes  []string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type CreateInput struct {
	ID               utilities.ID
	TargetRevisionID utilities.ID
	TenantID         utilities.ID
	Name             string
	URL              string
	Enabled          bool
	APIVersion       int
	EventTypes       []string
	CreatedByUserID  utilities.ID
	IdempotencyKey   string
}

type CreateResult struct {
	Endpoint Endpoint
	Secret   string
}

type PatchInput struct {
	TargetRevisionID utilities.ID
	Name             *string
	URL              *string
	Enabled          *bool
	APIVersion       *int
	EventTypes       *[]string
	ExpectedRevision int
	IdempotencyKey   string
}

type RotateResult struct {
	EndpointID              utilities.ID
	Revision                int
	Secret                  string
	PreviousSecretExpiresAt *time.Time
}

type Delivery struct {
	ID               utilities.ID
	EventID          utilities.ID
	EventType        string
	EndpointID       utilities.ID
	EndpointRevision int
	State            string
	AttemptCount     int
	NextAttemptAt    *time.Time
	TerminalAt       *time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

type Attempt struct {
	ID                  utilities.ID
	Number              int
	StartedAt           time.Time
	FinishedAt          *time.Time
	LatencyMilliseconds *int
	Outcome             string
	HTTPStatus          *int
	ErrorCode           *string
}

type DeliveryDetail struct {
	Delivery Delivery
	Event    json.RawMessage
	Attempts []Attempt
}
type DeliveryResult struct {
	EventID, DeliveryID, EndpointID utilities.ID
	EndpointRevision                int
	State                           string
}
type EndpointList struct {
	Endpoints []Endpoint
	Page      pagination.Page
}
type DeliveryList struct {
	Deliveries []Delivery
	Page       pagination.Page
}

type DeliveryFilters struct {
	States     []string
	EventTypes []string
}

type FailureAuditInput struct {
	TenantID     utilities.ID
	Action       string
	ResourceType string
	ResourceID   utilities.ID
	ErrorCode    string
}

type FailureAuditor interface {
	RecordWebhookFailure(context.Context, FailureAuditInput) error
}

type Repository interface {
	Create(context.Context, CreateInput) (CreateResult, error)
	Get(context.Context, utilities.ID, utilities.ID) (Endpoint, error)
	List(context.Context, utilities.ID, pagination.PageRequest) (EndpointList, error)
	Patch(context.Context, utilities.ID, utilities.ID, PatchInput, string, string) (Endpoint, error)
	Delete(context.Context, utilities.ID, utilities.ID, int, string) error
	RotateSecret(context.Context, utilities.ID, utilities.ID, bool, string) (RotateResult, error)
	Test(context.Context, utilities.ID, utilities.ID, string, EventMetadata) (DeliveryResult, error)
	ListDeliveries(context.Context, utilities.ID, utilities.ID, DeliveryFilters, pagination.PageRequest) (DeliveryList, error)
	GetDelivery(context.Context, utilities.ID, utilities.ID, utilities.ID) (DeliveryDetail, error)
	Redeliver(context.Context, utilities.ID, utilities.ID, utilities.ID, string) (DeliveryResult, error)
}
