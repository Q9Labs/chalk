package accessgrants

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidConfig       = errors.New("invalid access grant configuration")
	ErrInvalidSubject      = errors.New("invalid participant media subject")
	ErrSigningFailed       = errors.New("participant media credential signing failed")
	ErrMalformedCredential = errors.New("malformed participant media credential")
	ErrInvalidHeader       = errors.New("invalid participant media credential header")
	ErrUnknownKey          = errors.New("unknown participant media credential key")
	ErrInvalidSignature    = errors.New("invalid participant media credential signature")
	ErrInvalidIssuer       = errors.New("invalid participant media credential issuer")
	ErrInvalidAudience     = errors.New("invalid participant media credential audience")
	ErrInvalidTimeClaims   = errors.New("invalid participant media credential time claims")
	ErrNotYetValid         = errors.New("participant media credential is not yet valid")
	ErrExpired             = errors.New("participant media credential expired")
	ErrLifetimeExceeded    = errors.New("participant media credential lifetime exceeded")
	ErrSubjectMismatch     = errors.New("participant media credential subject mismatch")
)

const (
	Audience              = "chalk-media"
	ProviderCloudflareRTK = "cloudflare_rtk"
	ProviderCloudflareSFU = "cloudflare_sfu"
	Lifetime              = 5 * time.Minute
	ClockSkew             = 30 * time.Second
	RecoveryGrace         = 2 * time.Minute
)

type Subject struct {
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Provider              string
	// ProviderSubject is the provider-owned participant binding. SFU uses a
	// connection ID; RealtimeKit uses its participant reference. It is never a
	// provider access token.
	ProviderSubject        string
	CloudflareConnectionID string
}

type RouteSubject struct {
	TenantID               utilities.ID
	SpaceID                utilities.ID
	EpisodeID              utilities.ID
	ParticipantID          utilities.ID
	ParticipantGeneration  int64
	Provider               string
	ProviderSubject        string
	CloudflareConnectionID string
}

type MediaCredential struct {
	Token     string
	ExpiresAt time.Time
}

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
	switch subject.Provider {
	case ProviderCloudflareSFU:
		return subject.ProviderSubject == "" && route.ProviderSubject == "" &&
			subject.CloudflareConnectionID != "" &&
			subject.CloudflareConnectionID == route.CloudflareConnectionID
	case ProviderCloudflareRTK:
		return subject.CloudflareConnectionID == "" && route.CloudflareConnectionID == "" &&
			subject.ProviderSubject != "" &&
			subject.ProviderSubject == route.ProviderSubject
	default:
		return false
	}
}
