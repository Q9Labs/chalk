package httpapi

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// resumeOrReplaceAccessGrantJoin resumes the connection a media token is bound to. A closed SFU
// session does not revoke admission, so a gone session asks for a replacement, keyed like an
// expired token, instead of failing the request.
func resumeOrReplaceAccessGrantJoin(ctx context.Context, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, request issueAccessGrantRequest, subject accessgrants.Subject) (join mediaplane.Join, replace bool, err error) {
	join, err = resumeAccessGrantJoin(ctx, spacesService, tenantsService, resolver, request, subject)
	if errors.Is(err, mediaplane.ErrConnectionNotFound) {
		return mediaplane.Join{}, true, nil
	}
	return join, false, err
}

// reserveAccessGrantReplacement keys the reservation by the request token, so an overlapping
// identical request gets a retryable pending answer instead of a terminal supersede. The returned
// release puts the previous connection back when the request ends in failure.
func reserveAccessGrantReplacement(ctx context.Context, generations ParticipantGenerationAuthorizer, previous accessgrants.Subject, requestHash [32]byte) (accessgrants.Subject, func(failure *error), error) {
	reservation := previous
	reservation.ConnectionID = fmt.Sprintf("replacement:%x", requestHash)
	if err := generations.ReserveParticipantMediaRefresh(ctx, previous, reservation, requestHash); err != nil {
		return accessgrants.Subject{}, nil, accessGrantRefreshError(err)
	}
	release := func(failure *error) {
		if *failure == nil {
			return
		}
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := generations.ReplaceParticipantMediaConnection(cleanup, reservation, previous); err != nil && !errors.Is(err, accessgrants.ErrConnectionSuperseded) {
			*failure = errors.Join(*failure, fmt.Errorf("release media refresh reservation: %w", err))
		}
	}
	return reservation, release, nil
}
