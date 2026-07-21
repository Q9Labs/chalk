package apikeys

import (
	"context"
	"errors"
	"net/netip"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	MaxTTL            = 365 * 24 * time.Hour
	MaxNameRunes      = 100
	MaxPrefixAttempts = 4
)

var (
	ErrInvalidTenantID = errors.New("invalid tenant id")
	ErrInvalidAPIKeyID = errors.New("invalid api key id")
	ErrInvalidName     = errors.New("invalid api key name")
	ErrInvalidScopes   = errors.New("invalid api key scopes")
	ErrInvalidExpiry   = errors.New("invalid api key expiry")
	ErrAPIKeyNotFound  = errors.New("api key not found")
	ErrAPIKeyRevoked   = errors.New("api key revoked")
	ErrAPIKeyExpired   = errors.New("api key expired")
	ErrPrefixConflict  = errors.New("api key prefix conflict")
	ErrUnauthenticated = authentication.ErrUnauthenticated
)

type Key struct {
	ID              utilities.ID
	TenantID        utilities.ID
	Name            string
	Scopes          []authentication.Scope
	Prefix          string
	CreatedByUserID utilities.ID
	LastUsedAt      *time.Time
	RevokedAt       *time.Time
	ExpiresAt       time.Time
	UpdatedAt       time.Time
	CreatedAt       time.Time
}

type Record struct {
	KeyHash string
	Key
}

type CreateInput struct {
	TenantID        utilities.ID
	Name            string
	Scopes          []authentication.Scope
	ExpiresAt       time.Time
	CreatedByUserID utilities.ID
}

type CreateRecordInput struct {
	ID              utilities.ID
	TenantID        utilities.ID
	Name            string
	Scopes          []authentication.Scope
	KeyPrefix       string
	KeyHash         string
	ExpiresAt       time.Time
	CreatedByUserID utilities.ID
}

type CreateResult struct {
	Key    Key
	RawKey string
}

type RotateInput struct {
	ExpiresAt *time.Time
}

type RotateRecordInput struct {
	TenantID  utilities.ID
	ID        utilities.ID
	KeyPrefix string
	KeyHash   string
	ExpiresAt time.Time
	RotatedAt time.Time
}

type RotateResult struct {
	Key    Key
	RawKey string
}

type RecordList struct {
	Records []Record
	Page    pagination.Page
}

type KeyList struct {
	Keys []Key
	Page pagination.Page
}

type Usage struct {
	KeyID     utilities.ID
	UsedAt    time.Time
	IPAddress netip.Addr
}

type AuthenticateInput struct {
	RawKey    string
	IPAddress netip.Addr
}

type Repository interface {
	Create(context.Context, CreateRecordInput) (Record, error)
	Get(context.Context, utilities.ID, utilities.ID) (Record, error)
	GetByPrefix(context.Context, string) (Record, error)
	List(context.Context, utilities.ID, pagination.PageRequest) (RecordList, error)
	Rotate(context.Context, RotateRecordInput) (Record, error)
	Revoke(context.Context, utilities.ID, utilities.ID, time.Time) error
	TouchLastUsed(context.Context, Usage) error
}

type AuthenticationOutcome string

const (
	AuthenticationAccepted AuthenticationOutcome = "accepted"
	AuthenticationRejected AuthenticationOutcome = "rejected"
	AuthenticationFailed   AuthenticationOutcome = "failed"
)

type UsageTouchOutcome string

const (
	UsageTouchSucceeded UsageTouchOutcome = "succeeded"
	UsageTouchFailed    UsageTouchOutcome = "failed"
)

type AuthenticationEvent struct {
	Outcome AuthenticationOutcome
	Latency time.Duration
}

type Telemetry interface {
	RecordAuthentication(context.Context, AuthenticationEvent)
	RecordUsageTouch(context.Context, UsageTouchOutcome)
}
