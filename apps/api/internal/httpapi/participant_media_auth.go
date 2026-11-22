package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ParticipantMediaVerifier interface {
	Verify(context.Context, string) (accessgrants.Subject, error)
}

type ActiveParticipantAuthorizer interface {
	AuthorizeActiveParticipant(context.Context, accessgrants.Subject) (bool, error)
}

func requireParticipantMediaCredential(verifier ParticipantMediaVerifier) func(http.Handler) http.Handler {
	if verifier == nil {
		return unavailableMiddleware
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			credential, ok := bearerToken(r.Header.Get("Authorization"))
			if !ok {
				writeUnauthenticated(w)
				return
			}
			subject, err := verifier.Verify(r.Context(), credential)
			if err != nil {
				if isParticipantMediaCredentialRejection(err) {
					writeUnauthenticated(w)
					return
				}
				writeServiceUnavailable(w)
				return
			}
			ctx := accessgrants.WithSubject(r.Context(), subject)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// requireTelemetryCredential accepts the telemetry token, or the media credential in its place, and
// answers like requireParticipantMediaCredential otherwise.
func requireTelemetryCredential(telemetry TelemetryVerifier, media ParticipantMediaVerifier) func(http.Handler) http.Handler {
	var verifier ParticipantMediaVerifier
	if !missingService(telemetry) && !missingService(media) {
		verifier = telemetryCredentialVerifier{telemetry: telemetry, media: media}
	}
	return requireParticipantMediaCredential(verifier)
}

// telemetryCredentialVerifier asks the telemetry verifier first. It refuses a media credential by
// audience, so the media verifier only sees what the telemetry one did not accept.
type telemetryCredentialVerifier struct {
	telemetry TelemetryVerifier
	media     ParticipantMediaVerifier
}

func (v telemetryCredentialVerifier) Verify(ctx context.Context, credential string) (accessgrants.Subject, error) {
	subject, err := v.telemetry.VerifyTelemetry(ctx, credential)
	if err != nil && isParticipantMediaCredentialRejection(err) {
		return v.media.Verify(ctx, credential)
	}
	return subject, err
}

func requireParticipantMedia(verifier ParticipantMediaVerifier, authorizer ActiveParticipantAuthorizer) func(http.Handler) http.Handler {
	credential := requireParticipantMediaCredential(verifier)
	active := requireActiveParticipant(authorizer)
	return func(next http.Handler) http.Handler {
		return credential(active(next))
	}
}

func requireActiveParticipant(authorizer ActiveParticipantAuthorizer) func(http.Handler) http.Handler {
	if authorizer == nil {
		return unavailableMiddleware
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			subject, ok := accessgrants.SubjectFromContext(r.Context())
			if !ok {
				writeUnauthenticated(w)
				return
			}
			active, err := authorizer.AuthorizeActiveParticipant(r.Context(), subject)
			if errors.Is(err, accessgrants.ErrGenerationMismatch) {
				writeAPIError(w, apiErrorForbidden)
				return
			}
			if err != nil {
				writeServiceUnavailable(w)
				return
			}
			if !active {
				writeAPIError(w, apiErrorForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

type syncParticipantVerifier[Subject any] interface {
	VerifyParticipant(context.Context, string) (Subject, bool, error)
}

func requireSyncParticipant[Subject any](verifier syncParticipantVerifier[Subject], contextKey any) func(http.Handler) http.Handler {
	if verifier == nil {
		return unavailableMiddleware
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := bearerToken(r.Header.Get("Authorization"))
			if !ok {
				writeUnauthenticated(w)
				return
			}
			subject, valid, err := verifier.VerifyParticipant(r.Context(), token)
			if err != nil {
				writeServiceUnavailable(w)
				return
			}
			if !valid {
				writeUnauthenticated(w)
				return
			}
			ctx := context.WithValue(r.Context(), contextKey, subject)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func unavailableMiddleware(http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeServiceUnavailable(w)
	})
}

func requireParticipantMediaRoute(
	ctx context.Context,
	tenantID utilities.ID,
	spaceID utilities.ID,
	episodeID utilities.ID,
	participantID utilities.ID,
	participantGeneration int64,
	provider string,
	connectionID string,
) error {
	subject, ok := accessgrants.SubjectFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}

	err := accessgrants.RequireRouteSubject(subject, accessgrants.RouteSubject{
		TenantID:              tenantID,
		SpaceID:               spaceID,
		EpisodeID:             episodeID,
		ParticipantID:         participantID,
		ParticipantGeneration: participantGeneration,
		Provider:              provider,
		ConnectionID:          connectionID,
	})
	if err != nil {
		return apiErrorForbidden
	}
	return nil
}

func isParticipantMediaCredentialRejection(err error) bool {
	return errors.Is(err, accessgrants.ErrMalformedCredential) ||
		errors.Is(err, accessgrants.ErrInvalidHeader) ||
		errors.Is(err, accessgrants.ErrUnknownKey) ||
		errors.Is(err, accessgrants.ErrInvalidSignature) ||
		errors.Is(err, accessgrants.ErrInvalidIssuer) ||
		errors.Is(err, accessgrants.ErrInvalidAudience) ||
		errors.Is(err, accessgrants.ErrInvalidTimeClaims) ||
		errors.Is(err, accessgrants.ErrNotYetValid) ||
		errors.Is(err, accessgrants.ErrExpired) ||
		errors.Is(err, accessgrants.ErrLifetimeExceeded) ||
		errors.Is(err, accessgrants.ErrInvalidSubject)
}
