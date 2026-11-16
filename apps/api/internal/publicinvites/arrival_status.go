package publicinvites

import (
	"context"
	"errors"
	"fmt"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// admitPendingArrival grants access to a pending arrival that needs no host decision and marks it admitted.
func (r Runtime) admitPendingArrival(ctx context.Context, space PublicSpace, arrival Arrival, clients mediaplane.ClientProviders) (PublicSpaceArrival, error) {
	grant, err := r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrival, RequireAdmission: AdmissionOpen, MediaClients: clients})
	if errors.Is(err, ErrArrivalUnavailable) {
		return r.arrivalWithdrawn(ctx, space, arrival)
	}
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		return PublicSpaceArrival{}, r.discardProvisionalPublicAccess(ctx, grant, err)
	}
	admitted, err := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
		TenantID:              arrival.TenantID,
		ArrivalHandle:         arrival.ArrivalHandle,
		State:                 ArrivalAdmitted,
		RequirePending:        true,
		RequireAdmission:      AdmissionOpen,
		EpisodeID:             grant.EpisodeID,
		ParticipantID:         grant.ParticipantID,
		ParticipantGeneration: grant.ParticipantGeneration,
		Provider:              grant.Provider,
		ProviderSubject:       grant.ProviderSubject,
	})
	if errors.Is(err, ErrArrivalUnavailable) {
		cleanupErr := r.discardProvisionalPublicAccess(ctx, grant, nil)
		result, withdrawnErr := r.arrivalWithdrawn(ctx, space, arrival)
		return result, errors.Join(cleanupErr, withdrawnErr)
	}
	if err != nil {
		return PublicSpaceArrival{}, r.discardProvisionalPublicAccess(ctx, grant, err)
	}
	result := r.arrivalResult(space, admitted)
	result.Access = &grant
	return result, nil
}

// arrivalWithdrawn reports a pending arrival whose invite, Space or Episode no longer admits it, and closes it.
func (r Runtime) arrivalWithdrawn(ctx context.Context, space PublicSpace, arrival Arrival) (PublicSpaceArrival, error) {
	terminal, err := r.invalidatePendingArrival(ctx, arrival)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	return r.arrivalResult(space, terminal), nil
}

func (r Runtime) ArrivalStatus(ctx context.Context, input PublicInviteArrivalStatusInput, beforeWrite func() error) (PublicSpaceArrival, error) {
	arrival, err := r.authenticateArrival(ctx, input.ArrivalHandle, input.GuestCredential, input.AccountID)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	space, err := r.space.GetPublicSpace(ctx, arrival.TenantID, arrival.SpaceID)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if space.TenantID != arrival.TenantID || space.SpaceID != arrival.SpaceID {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	if arrival.State == ArrivalPending && arrival.IdentityMode == IdentityGuest {
		if result, resolved, err := r.resolvePendingAdmission(ctx, space, arrival, input.MediaClients, beforeWrite); resolved || err != nil {
			return result, err
		}
		valid, validationErr := r.pendingGuestArrivalValid(ctx, arrival, space)
		if validationErr != nil {
			return PublicSpaceArrival{}, validationErr
		}
		if !valid {
			if err := beforeWrite(); err != nil {
				return PublicSpaceArrival{}, err
			}
			arrival, validationErr = r.invalidatePendingArrival(ctx, arrival)
			if validationErr != nil {
				return PublicSpaceArrival{}, validationErr
			}
		}
	}
	// The host opened the Space while the guest waited: no decision is left to wait for.
	if arrival.State == ArrivalPending && arrival.IdentityMode == IdentityGuest && space.AdmissionMode == AdmissionOpen {
		if err := beforeWrite(); err != nil {
			return PublicSpaceArrival{}, err
		}
		return r.admitPendingArrival(ctx, space, arrival, input.MediaClients)
	}
	if arrival.State == ArrivalAdmitted {
		if err := beforeWrite(); err != nil {
			return PublicSpaceArrival{}, err
		}
		result, err := r.resumeAdmittedArrival(ctx, space, arrival, input.MediaClients)
		if errors.Is(err, mediaplane.ErrConnectionNotFound) {
			// A lost SFU session does not revoke admission. Replacement still
			// requires the saved media proof through RefreshAccess.
			return r.arrivalResult(space, arrival), nil
		}
		return result, err
	}
	return r.arrivalResult(space, arrival), nil
}

func (r Runtime) resumeAdmittedArrival(ctx context.Context, space PublicSpace, arrival Arrival, clients mediaplane.ClientProviders) (PublicSpaceArrival, error) {
	grant, err := r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrival, MediaClients: clients})
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		return PublicSpaceArrival{}, err
	}
	result := r.arrivalResult(space, arrival)
	result.Access = &grant
	return result, nil
}

func (r Runtime) resolvePendingAdmission(ctx context.Context, space PublicSpace, arrival Arrival, clients mediaplane.ClientProviders, beforeWrite func() error) (PublicSpaceArrival, bool, error) {
	request, err := r.service.repository.GetAdmissionRequestForArrival(ctx, arrival)
	if errors.Is(err, ErrAdmissionRequestNotFound) {
		return PublicSpaceArrival{}, false, nil
	}
	if err != nil {
		return PublicSpaceArrival{}, false, err
	}
	switch request.State {
	case AdmissionRequestApproved, AdmissionRequestDenied, AdmissionRequestExpired, AdmissionRequestInvalidated:
		if err := beforeWrite(); err != nil {
			return PublicSpaceArrival{}, false, err
		}
	default:
		return PublicSpaceArrival{}, false, nil
	}
	state, reason := ArrivalPending, ""
	var cleanupErr error
	switch request.State {
	case AdmissionRequestApproved:
		grant, err := r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrival, Admission: request.Binding, RequireAdmission: AdmissionKnock, MediaClients: clients})
		if errors.Is(err, ErrArrivalUnavailable) {
			state, reason = ArrivalUnavailable, "admission_episode_ended"
			break
		}
		if err != nil {
			return PublicSpaceArrival{}, false, err
		}
		if err := validateAccessGrant(grant, arrival); err != nil {
			return PublicSpaceArrival{}, false, r.discardProvisionalPublicAccess(ctx, grant, err)
		}
		admitted, err := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
			TenantID: arrival.TenantID, ArrivalHandle: arrival.ArrivalHandle, State: ArrivalAdmitted, RequirePending: true, RequireAdmission: AdmissionKnock,
			EpisodeID: grant.EpisodeID, ParticipantID: grant.ParticipantID, ParticipantGeneration: grant.ParticipantGeneration,
			Provider: grant.Provider, ProviderSubject: grant.ProviderSubject,
		})
		if err != nil {
			current, readErr := r.service.GetArrival(ctx, arrival.ArrivalHandle)
			if readErr != nil || current.State != ArrivalAdmitted || current.Provider != grant.Provider || current.ProviderSubject != grant.ProviderSubject {
				cleanupErr = r.discardProvisionalPublicAccess(ctx, grant, nil)
			}
			if readErr == nil && current.State != ArrivalPending {
				return r.arrivalResult(space, current), true, cleanupErr
			}
			if readErr == nil && errors.Is(err, ErrArrivalUnavailable) {
				state, reason = ArrivalUnavailable, "public_arrival_invalidated"
				break
			}
			return PublicSpaceArrival{}, false, errors.Join(err, readErr, cleanupErr)
		}
		RecordAdmissionOutcome(ctx, admitted, "approved")
		result := r.arrivalResult(space, admitted)
		result.Access = &grant
		return result, true, nil
	case AdmissionRequestDenied:
		state, reason = ArrivalRejected, "admission_denied"
	case AdmissionRequestExpired:
		state, reason = ArrivalUnavailable, "admission_request_expired"
	case AdmissionRequestInvalidated:
		state, reason = ArrivalUnavailable, "public_arrival_invalidated"
	}
	if state == ArrivalPending {
		return PublicSpaceArrival{}, false, nil
	}
	terminal, err := r.finishPendingArrival(ctx, arrival, state, reason)
	if err != nil {
		return PublicSpaceArrival{}, false, errors.Join(err, cleanupErr)
	}
	return r.arrivalResult(space, terminal), true, cleanupErr
}

func (r Runtime) pendingGuestArrivalValid(ctx context.Context, arrival Arrival, space PublicSpace) (bool, error) {
	if (!arrival.ExpiresAt.IsZero() && !arrival.ExpiresAt.After(r.service.now())) || space.Archived || (space.AdmissionMode != AdmissionKnock && space.AdmissionMode != AdmissionOpen) {
		return false, nil
	}
	if len(arrival.InviteHandle) == 0 {
		return true, nil
	}
	invite, err := r.service.repository.GetInviteByHandle(ctx, arrival.InviteHandle)
	if errors.Is(err, ErrInviteNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := validateInvite(invite); err != nil || !invite.Enabled || invite.TenantID != arrival.TenantID || invite.SpaceID != arrival.SpaceID || invite.Generation != arrival.InviteGeneration || invite.StateEpoch != arrival.InviteStateEpoch || !bytes.Equal(invite.Handle, arrival.InviteHandle) {
		return false, nil
	}
	return true, nil
}

func (r Runtime) invalidatePendingArrival(ctx context.Context, arrival Arrival) (Arrival, error) {
	reason := "public_arrival_invalidated"
	if !arrival.ExpiresAt.IsZero() && !arrival.ExpiresAt.After(r.service.now()) {
		reason = "admission_request_expired"
	}
	return r.finishPendingArrival(ctx, arrival, ArrivalUnavailable, reason)
}

func (r Runtime) finishPendingArrival(ctx context.Context, arrival Arrival, state ArrivalState, reason string) (Arrival, error) {
	updated, err := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{TenantID: arrival.TenantID, ArrivalHandle: arrival.ArrivalHandle, State: state, Reason: reason, RequirePending: true})
	if errors.Is(err, ErrArrivalUnavailable) {
		current, readErr := r.service.GetArrival(ctx, arrival.ArrivalHandle)
		if readErr != nil {
			return Arrival{}, readErr
		}
		if current.State != ArrivalPending {
			return current, nil
		}
	}
	if err == nil {
		RecordAdmissionOutcome(ctx, updated, reason)
	}
	return updated, err
}

func (r Runtime) Status(ctx context.Context, input PublicInviteArrivalStatusInput, beforeInvalidate func() error) (PublicSpaceArrival, error) {
	return r.ArrivalStatus(ctx, input, beforeInvalidate)
}

func (r Runtime) discardProvisionalPublicAccess(ctx context.Context, grant PublicAccessGrant, cause error) error {
	if err := r.access.DiscardPublicAccess(ctx, grant); err != nil {
		return errors.Join(cause, fmt.Errorf("discard provisional public access: %w", err))
	}
	return cause
}
