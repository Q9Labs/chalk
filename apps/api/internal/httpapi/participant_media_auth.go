package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/participantaccess"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ParticipantMediaVerifier interface {
	Verify(context.Context, string) (participantaccess.Subject, error)
}

type ActiveParticipantAuthorizer interface {
	AuthorizeActiveParticipant(context.Context, participantaccess.Subject) (bool, error)
}

func requireParticipantMedia(verifier ParticipantMediaVerifier, authorizer ActiveParticipantAuthorizer) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if verifier == nil || authorizer == nil {
				writeServiceUnavailable(w)
				return
			}

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

			active, err := authorizer.AuthorizeActiveParticipant(r.Context(), subject)
			if err != nil {
				writeServiceUnavailable(w)
				return
			}
			if !active {
				writeAPIError(w, apiErrorForbidden)
				return
			}

			ctx := participantaccess.WithSubject(r.Context(), subject)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func requireParticipantMediaRoute(
	ctx context.Context,
	tenantID utilities.ID,
	roomID utilities.ID,
	sessionID utilities.ID,
	participantSessionID utilities.ID,
	participantGeneration int64,
	provider string,
	connectionID string,
) error {
	subject, ok := participantaccess.SubjectFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}

	err := participantaccess.RequireRouteSubject(subject, participantaccess.RouteSubject{
		TenantID:               tenantID,
		RoomID:                 roomID,
		SessionID:              sessionID,
		ParticipantSessionID:   participantSessionID,
		ParticipantGeneration:  participantGeneration,
		Provider:               provider,
		CloudflareConnectionID: connectionID,
	})
	if err != nil {
		return apiErrorForbidden
	}
	return nil
}

func isParticipantMediaCredentialRejection(err error) bool {
	return errors.Is(err, participantaccess.ErrMalformedCredential) ||
		errors.Is(err, participantaccess.ErrInvalidHeader) ||
		errors.Is(err, participantaccess.ErrUnknownKey) ||
		errors.Is(err, participantaccess.ErrInvalidSignature) ||
		errors.Is(err, participantaccess.ErrInvalidIssuer) ||
		errors.Is(err, participantaccess.ErrInvalidAudience) ||
		errors.Is(err, participantaccess.ErrInvalidTimeClaims) ||
		errors.Is(err, participantaccess.ErrNotYetValid) ||
		errors.Is(err, participantaccess.ErrExpired) ||
		errors.Is(err, participantaccess.ErrLifetimeExceeded) ||
		errors.Is(err, participantaccess.ErrInvalidSubject)
}
