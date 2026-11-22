package accessgrants

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidConfig        = errors.New("invalid access grant configuration")
	ErrInvalidSubject       = errors.New("invalid participant media subject")
	ErrSigningFailed        = errors.New("participant media credential signing failed")
	ErrMalformedCredential  = errors.New("malformed participant media credential")
	ErrInvalidHeader        = errors.New("invalid participant media credential header")
	ErrUnknownKey           = errors.New("unknown participant media credential key")
	ErrInvalidSignature     = errors.New("invalid participant media credential signature")
	ErrInvalidIssuer        = errors.New("invalid participant media credential issuer")
	ErrInvalidAudience      = errors.New("invalid participant media credential audience")
	ErrInvalidTimeClaims    = errors.New("invalid participant media credential time claims")
	ErrNotYetValid          = errors.New("participant media credential is not yet valid")
	ErrExpired              = errors.New("participant media credential expired")
	ErrLifetimeExceeded     = errors.New("participant media credential lifetime exceeded")
	ErrConnectionSuperseded = errors.New("participant media connection superseded")
	ErrRefreshPending       = errors.New("participant media replacement is pending")
	ErrGenerationMismatch   = errors.New("participant media generation mismatch")
	ErrSubjectMismatch      = errors.New("participant media credential subject mismatch")
)

const (
	Audience = "chalk-media"
	// TelemetryAudience marks the credential that authorizes only the telemetry route. It is signed
	// with the media credential's key for the same subject, and neither verifies as the other.
	TelemetryAudience = "chalk-telemetry"

	ProviderChalkSFU = "chalk_sfu"
	Lifetime         = 5 * time.Minute
	// TelemetryLifetime is long because the credential buys delivery of a client's last records
	// after a reload or a long background, not access to anything else.
	TelemetryLifetime = 24 * time.Hour
	ClockSkew         = 30 * time.Second
	RecoveryGrace     = 2 * time.Minute
)

type Subject struct {
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Provider              string
	// ProviderSubject is the provider-owned participant binding, never a provider
	// access token. Both SFU providers use ConnectionID instead.
	ProviderSubject string
	ConnectionID    string
}

type RouteSubject struct {
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Provider              string
	ProviderSubject       string
	ConnectionID          string
}

type MediaCredential struct {
	Token     string
	ExpiresAt time.Time
}

type TelemetryCredential struct {
	Token     string
	ExpiresAt time.Time
}

// credentialKind is what tells the two credentials of a subject apart: who may be sent it and for how long.
type credentialKind struct {
	audience string
	lifetime time.Duration
}

var (
	mediaKind     = credentialKind{audience: Audience, lifetime: Lifetime}
	telemetryKind = credentialKind{audience: TelemetryAudience, lifetime: TelemetryLifetime}
)

type subjectContextKey struct{}

func WithSubject(ctx context.Context, subject Subject) context.Context {
	return context.WithValue(ctx, subjectContextKey{}, subject)
}

func SubjectFromContext(ctx context.Context) (Subject, bool) {
	subject, ok := ctx.Value(subjectContextKey{}).(Subject)
	return subject, ok
}

func RequireRouteSubject(subject Subject, route RouteSubject) error {
	if subject.TenantID != route.TenantID ||
		subject.SpaceID != route.SpaceID ||
		subject.EpisodeID != route.EpisodeID ||
		subject.ParticipantID != route.ParticipantID ||
		subject.ParticipantGeneration != route.ParticipantGeneration ||
		subject.Provider != route.Provider ||
		!sameProviderBinding(subject, route) {
		return ErrSubjectMismatch
	}
	return nil
}

func sameProviderBinding(subject Subject, route RouteSubject) bool {
	return subject.Provider == ProviderChalkSFU &&
		subject.ProviderSubject == "" && route.ProviderSubject == "" &&
		subject.ConnectionID != "" && subject.ConnectionID == route.ConnectionID
}
