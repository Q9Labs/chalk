// Package tenanthandovers models the explicit ownership handover of a Tenant.
package tenanthandovers

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	StatusPending  = "pending"
	StatusAccepted = "accepted"
	StatusCanceled = "canceled"
	StatusExpired  = "expired"

	ActorService  = "service"
	ActorOperator = "operator"

	DefaultExpiresInSeconds int64 = 7 * 24 * 60 * 60
	MinExpiresInSeconds     int64 = 60
	MaxExpiresInSeconds     int64 = 30 * 24 * 60 * 60
)

var (
	ErrInvalidHandoverID       = errors.New("invalid tenant handover id")
	ErrInvalidTenantID         = errors.New("invalid tenant id")
	ErrInvalidRecipientEmail   = errors.New("invalid tenant handover recipient email")
	ErrInvalidExpiry           = errors.New("invalid tenant handover expiry")
	ErrInvalidRequestKey       = errors.New("invalid tenant handover request key")
	ErrInvalidActor            = errors.New("invalid tenant handover actor")
	ErrHandoverNotFound        = errors.New("tenant handover not found")
	ErrHandoverAlreadyPending  = errors.New("tenant already has a pending handover")
	ErrIdempotencyConflict     = errors.New("tenant handover request key conflicts with original request")
	ErrHandoverExpired         = errors.New("tenant handover expired")
	ErrHandoverCanceled        = errors.New("tenant handover canceled")
	ErrHandoverAlreadyAccepted = errors.New("tenant handover already accepted")
	ErrRecipientMismatch       = errors.New("tenant handover recipient mismatch")
	ErrOwnershipChanged        = errors.New("tenant handover ownership changed")
	ErrForbidden               = errors.New("tenant handover forbidden")
)

var requestKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

type Actor struct {
	Kind      string
	ServiceID string
	Operator  string
}

type Handover struct {
	ID               utilities.ID
	TenantID         utilities.ID
	RecipientEmail   string
	Status           string
	RequestKey       string
	FromServiceID    string
	ToServiceID      string
	InitiatedBy      Actor
	AcceptedByUserID utilities.ID
	AcceptedAt       *time.Time
	CanceledBy       *Actor
	CanceledAt       *time.Time
	ExpiresAt        time.Time
	UpdatedAt        time.Time
	CreatedAt        time.Time
}

func (h Handover) EffectiveStatus(now time.Time) string {
	if h.Status == StatusPending && !h.ExpiresAt.After(now.UTC()) {
		return StatusExpired
	}
	return h.Status
}

type CreateInput struct {
	ID               utilities.ID
	TenantID         utilities.ID
	RecipientEmail   string
	ExpiresInSeconds int64
	RequestKey       string
	ToServiceID      string
	FromServiceID    string
	Actor            Actor
}

type CreateResult struct {
	Handover Handover
	Replayed bool
}

type AcceptInput struct {
	HandoverID     utilities.ID
	RecipientEmail string
	RecipientName  string
}

type AcceptResult struct {
	Handover Handover
	UserID   utilities.ID
}

type CancelInput struct {
	TenantID   utilities.ID
	HandoverID utilities.ID
	Actor      Actor
}

type Repository interface {
	Create(context.Context, CreateInput, time.Time, [32]byte) (Handover, bool, error)
	GetForTenant(context.Context, utilities.ID, utilities.ID) (Handover, error)
	Get(context.Context, utilities.ID) (Handover, error)
	Cancel(context.Context, CancelInput, time.Time) (Handover, error)
	Accept(context.Context, AcceptInput, time.Time) (AcceptResult, error)
	LatestAcceptedForEmail(context.Context, string) (Handover, error)
}

type Service struct {
	repository Repository
	now        func() time.Time
}

func NewService(repository Repository) Service {
	return Service{repository: repository, now: time.Now}
}

func (s Service) WithClock(now func() time.Time) Service {
	s.now = now
	return s
}

func (s Service) Create(ctx context.Context, input CreateInput) (CreateResult, error) {
	if input.TenantID.IsZero() {
		return CreateResult{}, ErrInvalidTenantID
	}
	email, err := NormalizeEmail(input.RecipientEmail)
	if err != nil {
		return CreateResult{}, err
	}
	input.RecipientEmail = email
	if input.ExpiresInSeconds == 0 {
		input.ExpiresInSeconds = DefaultExpiresInSeconds
	}
	if input.ExpiresInSeconds < MinExpiresInSeconds || input.ExpiresInSeconds > MaxExpiresInSeconds {
		return CreateResult{}, ErrInvalidExpiry
	}
	if !requestKeyPattern.MatchString(input.RequestKey) {
		return CreateResult{}, ErrInvalidRequestKey
	}
	if !validActor(input.Actor) {
		return CreateResult{}, ErrInvalidActor
	}
	if !validServiceID(input.ToServiceID) {
		return CreateResult{}, ErrInvalidActor
	}
	if input.ID.IsZero() {
		var err error
		input.ID, err = utilities.NewID()
		if err != nil {
			return CreateResult{}, err
		}
	}
	fingerprint, err := createFingerprint(input)
	if err != nil {
		return CreateResult{}, err
	}
	handover, replayed, err := s.repository.Create(ctx, input, s.now().UTC(), fingerprint)
	if err != nil {
		return CreateResult{}, err
	}
	return CreateResult{Handover: handover, Replayed: replayed}, nil
}

func (s Service) GetForTenant(ctx context.Context, tenantID, handoverID utilities.ID) (Handover, error) {
	if tenantID.IsZero() {
		return Handover{}, ErrInvalidTenantID
	}
	if handoverID.IsZero() {
		return Handover{}, ErrInvalidHandoverID
	}
	return s.repository.GetForTenant(ctx, tenantID, handoverID)
}

func (s Service) Get(ctx context.Context, handoverID utilities.ID) (Handover, error) {
	if handoverID.IsZero() {
		return Handover{}, ErrInvalidHandoverID
	}
	return s.repository.Get(ctx, handoverID)
}

func (s Service) Cancel(ctx context.Context, input CancelInput) (Handover, error) {
	if input.TenantID.IsZero() {
		return Handover{}, ErrInvalidTenantID
	}
	if input.HandoverID.IsZero() {
		return Handover{}, ErrInvalidHandoverID
	}
	if !validActor(input.Actor) {
		return Handover{}, ErrInvalidActor
	}
	return s.repository.Cancel(ctx, input, s.now().UTC())
}

func (s Service) Accept(ctx context.Context, input AcceptInput) (AcceptResult, error) {
	if input.HandoverID.IsZero() {
		return AcceptResult{}, ErrInvalidHandoverID
	}
	email, err := NormalizeEmail(input.RecipientEmail)
	if err != nil {
		return AcceptResult{}, err
	}
	input.RecipientEmail = email
	input.RecipientName = strings.TrimSpace(input.RecipientName)
	if input.RecipientName == "" {
		input.RecipientName = email
	}
	if len([]rune(input.RecipientName)) > 200 {
		input.RecipientName = string([]rune(input.RecipientName)[:200])
	}
	return s.repository.Accept(ctx, input, s.now().UTC())
}

func (s Service) LatestAcceptedForEmail(ctx context.Context, email string) (Handover, error) {
	normalized, err := NormalizeEmail(email)
	if err != nil {
		return Handover{}, err
	}
	return s.repository.LatestAcceptedForEmail(ctx, normalized)
}

func NormalizeEmail(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	address, err := mail.ParseAddress(value)
	if err != nil || address.Address != value || len(value) > 320 {
		return "", ErrInvalidRecipientEmail
	}
	return value, nil
}

func validActor(actor Actor) bool {
	switch actor.Kind {
	case ActorService:
		return validServiceID(actor.ServiceID) && actor.Operator == ""
	case ActorOperator:
		return actor.ServiceID == "" && strings.TrimSpace(actor.Operator) != "" && len([]rune(actor.Operator)) <= 200
	default:
		return false
	}
}

func validServiceID(value string) bool {
	return len(value) >= 1 && len(value) <= 128 && strings.TrimSpace(value) == value
}

func createFingerprint(input CreateInput) ([32]byte, error) {
	value, err := json.Marshal(struct {
		RecipientEmail   string `json:"recipient_email"`
		ExpiresInSeconds int64  `json:"expires_in_seconds"`
	}{input.RecipientEmail, input.ExpiresInSeconds})
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(value), nil
}
