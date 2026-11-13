package publicinvites

import (
	"bytes"
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// admitNewArrival applies the Space's admission mode to a recorded Arrival.
func (r Runtime) admitNewArrival(ctx context.Context, input PublicInviteArrivalInput, name string, space PublicSpace, arrival Arrival, accountAuthorized bool) (PublicSpaceArrival, error) {
	switch {
	case accountAuthorized || space.AdmissionMode == AdmissionOpen:
		switch arrival.State {
		case ArrivalAdmitted:
			return r.resumeAdmittedArrival(ctx, space, arrival, input.MediaClients)
		case ArrivalPending:
			return r.grantAndAdmit(ctx, space, arrival, input.MediaClients)
		}
		return PublicSpaceArrival{}, ErrArrivalUnavailable
	case space.AdmissionMode == AdmissionKnock:
		return r.knock(ctx, input, name, space, arrival)
	}
	return PublicSpaceArrival{}, ErrInviteUnavailable
}

// knock asks the Space's hosts to admit a pending Arrival.
func (r Runtime) knock(ctx context.Context, input PublicInviteArrivalInput, name string, space PublicSpace, arrival Arrival) (PublicSpaceArrival, error) {
	switch arrival.State {
	case ArrivalPending:
	case ArrivalAdmitted:
		return r.resumeAdmittedArrival(ctx, space, arrival, input.MediaClients)
	default:
		return r.arrivalResult(space, arrival), nil
	}
	_, err := r.service.CreateAdmissionRequest(ctx, CreateAdmissionRequestInput{ArrivalHandle: arrival.ArrivalHandle, DisplayName: name, MediaClients: input.MediaClients})
	if errors.Is(err, ErrArrivalUnavailable) {
		terminal, err := r.invalidatePendingArrival(ctx, arrival)
		if err != nil {
			return PublicSpaceArrival{}, err
		}
		return r.arrivalResult(space, terminal), nil
	}
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	return r.arrivalResult(space, arrival), nil
}

// grantAndAdmit grants media access to a pending Arrival, then records it as
// admitted with the grant's participant.
func (r Runtime) grantAndAdmit(ctx context.Context, space PublicSpace, arrival Arrival, clients mediaplane.ClientProviders) (PublicSpaceArrival, error) {
	grant, err := r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrival, MediaClients: clients})
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		return PublicSpaceArrival{}, err
	}
	admitted, err := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
		TenantID:              arrival.TenantID,
		ArrivalHandle:         arrival.ArrivalHandle,
		State:                 ArrivalAdmitted,
		EpisodeID:             grant.EpisodeID,
		ParticipantID:         grant.ParticipantID,
		ParticipantGeneration: grant.ParticipantGeneration,
		Provider:              grant.Provider,
		ProviderSubject:       grant.ProviderSubject,
	})
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	result := r.arrivalResult(space, admitted)
	result.Access = &grant
	return result, nil
}

// dropStalePendingGuest ends a pending guest Arrival whose invite or Space no
// longer admits it. beforeWrite runs first and may be nil.
func (r Runtime) dropStalePendingGuest(ctx context.Context, arrival Arrival, space PublicSpace, beforeWrite func() error) (Arrival, error) {
	valid, err := r.pendingGuestArrivalValid(ctx, arrival, space)
	if err != nil || valid {
		return arrival, err
	}
	if beforeWrite != nil {
		if err := beforeWrite(); err != nil {
			return Arrival{}, err
		}
	}
	return r.invalidatePendingArrival(ctx, arrival)
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

// arrivalEnding is how a settled admission request ends a pending Arrival.
type arrivalEnding struct {
	state  ArrivalState
	reason string
}

var settledAdmissionEndings = map[AdmissionRequestState]arrivalEnding{
	AdmissionRequestDenied:      {ArrivalRejected, "admission_denied"},
	AdmissionRequestExpired:     {ArrivalUnavailable, "admission_request_expired"},
	AdmissionRequestInvalidated: {ArrivalUnavailable, "public_arrival_invalidated"},
}

// resolvePendingAdmission applies a settled admission request to its pending
// Arrival. It reports false when the request is missing or still open.
func (r Runtime) resolvePendingAdmission(ctx context.Context, space PublicSpace, arrival Arrival, clients mediaplane.ClientProviders, beforeWrite func() error) (PublicSpaceArrival, bool, error) {
	request, err := r.service.repository.GetAdmissionRequestForArrival(ctx, arrival)
	if errors.Is(err, ErrAdmissionRequestNotFound) {
		return PublicSpaceArrival{}, false, nil
	}
	if err != nil {
		return PublicSpaceArrival{}, false, err
	}
	ending, settled := settledAdmissionEndings[request.State]
	if !settled && request.State != AdmissionRequestApproved {
		return PublicSpaceArrival{}, false, nil
	}
	if err := beforeWrite(); err != nil {
		return PublicSpaceArrival{}, false, err
	}
	if request.State == AdmissionRequestApproved {
		result, failed, err := r.admitApproved(ctx, space, arrival, request, clients)
		if err != nil {
			return PublicSpaceArrival{}, false, err
		}
		if failed == nil {
			return result, true, nil
		}
		ending = *failed
	}
	terminal, err := r.finishPendingArrival(ctx, arrival, ending.state, ending.reason)
	if err != nil {
		return PublicSpaceArrival{}, false, err
	}
	return r.arrivalResult(space, terminal), true, nil
}

// admitApproved grants access for an approved admission request and records
// the Arrival as admitted. When the Arrival can no longer be admitted it
// returns the ending to record instead of a result.
func (r Runtime) admitApproved(ctx context.Context, space PublicSpace, arrival Arrival, request AdmissionRequest, clients mediaplane.ClientProviders) (PublicSpaceArrival, *arrivalEnding, error) {
	grant, err := r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrival, Admission: request.Binding, RequireKnock: true, MediaClients: clients})
	if errors.Is(err, ErrArrivalUnavailable) {
		return PublicSpaceArrival{}, &arrivalEnding{ArrivalUnavailable, "admission_episode_ended"}, nil
	}
	if err != nil {
		return PublicSpaceArrival{}, nil, err
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		_ = r.access.DiscardPublicAccess(ctx, grant)
		return PublicSpaceArrival{}, nil, err
	}
	admitted, err := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
		TenantID: arrival.TenantID, ArrivalHandle: arrival.ArrivalHandle, State: ArrivalAdmitted, RequirePending: true,
		EpisodeID: grant.EpisodeID, ParticipantID: grant.ParticipantID, ParticipantGeneration: grant.ParticipantGeneration,
		Provider: grant.Provider, ProviderSubject: grant.ProviderSubject,
	})
	if err != nil {
		return r.recoverAdmissionConflict(ctx, space, arrival, grant, err)
	}
	RecordAdmissionOutcome(ctx, admitted, "approved")
	result := r.arrivalResult(space, admitted)
	result.Access = &grant
	return result, nil, nil
}

// recoverAdmissionConflict reads the Arrival again after a failed admit. It
// drops the grant unless another request already admitted the same participant.
func (r Runtime) recoverAdmissionConflict(ctx context.Context, space PublicSpace, arrival Arrival, grant PublicAccessGrant, updateErr error) (PublicSpaceArrival, *arrivalEnding, error) {
	current, readErr := r.service.GetArrival(ctx, arrival.ArrivalHandle)
	if readErr != nil || current.State != ArrivalAdmitted || current.Provider != grant.Provider || current.ProviderSubject != grant.ProviderSubject {
		_ = r.access.DiscardPublicAccess(ctx, grant)
	}
	switch {
	case readErr == nil && current.State != ArrivalPending:
		return r.arrivalResult(space, current), nil, nil
	case readErr == nil && errors.Is(updateErr, ErrArrivalUnavailable):
		return PublicSpaceArrival{}, &arrivalEnding{ArrivalUnavailable, "public_arrival_invalidated"}, nil
	}
	return PublicSpaceArrival{}, nil, updateErr
}

func (r Runtime) pendingGuestArrivalValid(ctx context.Context, arrival Arrival, space PublicSpace) (bool, error) {
	if (!arrival.ExpiresAt.IsZero() && !arrival.ExpiresAt.After(r.service.now())) || space.Archived || space.AdmissionMode != AdmissionKnock {
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
