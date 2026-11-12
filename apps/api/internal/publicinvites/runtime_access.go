package publicinvites

import "context"

func (r Runtime) Status(ctx context.Context, input PublicInviteArrivalStatusInput, beforeInvalidate func() error) (PublicSpaceArrival, error) {
	return r.ArrivalStatus(ctx, input, beforeInvalidate)
}

func (r Runtime) RefreshAccess(ctx context.Context, input PublicInviteRefreshInput) (PublicAccessGrant, error) {
	arrival, err := r.authenticateArrival(ctx, input.ArrivalHandle, input.GuestCredential, input.AccountID)
	if err != nil {
		return PublicAccessGrant{}, err
	}
	if arrival.State != ArrivalAdmitted {
		return PublicAccessGrant{}, ErrArrivalUnavailable
	}
	grant, err := r.access.RefreshPublicAccess(ctx, PublicAccessInput{Arrival: arrival, MediaProof: input.MediaProof, ReplaceMediaConnection: input.ReplaceMediaConnection, MediaClients: input.MediaClients})
	if err != nil {
		return PublicAccessGrant{}, err
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		return PublicAccessGrant{}, err
	}
	if input.ReplaceMediaConnection {
		if _, err := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
			TenantID:                arrival.TenantID,
			ArrivalHandle:           arrival.ArrivalHandle,
			State:                   ArrivalAdmitted,
			EpisodeID:               grant.EpisodeID,
			ParticipantID:           grant.ParticipantID,
			ParticipantGeneration:   grant.ParticipantGeneration,
			Provider:                grant.Provider,
			ProviderSubject:         grant.ProviderSubject,
			MatchProviderBinding:    true,
			ExpectedProvider:        arrival.Provider,
			ExpectedProviderSubject: arrival.ProviderSubject,
		}); err != nil {
			_ = r.access.DiscardPublicAccess(ctx, grant)
			return PublicAccessGrant{}, err
		}
		r.discardSupersededPublicAccess(ctx, arrival, grant)
	}
	return grant, nil
}

func (r Runtime) discardSupersededPublicAccess(ctx context.Context, arrival Arrival, grant PublicAccessGrant) {
	if arrival.Provider == grant.Provider && arrival.ProviderSubject == grant.ProviderSubject {
		return
	}
	previous := grant
	previous.Provider = arrival.Provider
	previous.ProviderSubject = arrival.ProviderSubject
	_ = r.access.DiscardPublicAccess(ctx, previous)
}

func (r Runtime) Refresh(ctx context.Context, input PublicInviteRefreshInput) (PublicAccessGrant, error) {
	return r.RefreshAccess(ctx, input)
}

func (r Runtime) Leave(ctx context.Context, input PublicInviteLeaveInput) error {
	arrival, err := r.authenticateArrival(ctx, input.ArrivalHandle, input.GuestCredential, input.AccountID)
	if err != nil {
		return err
	}
	if arrival.State == ArrivalPending {
		arrival, err = r.finishPendingArrival(ctx, arrival, ArrivalUnavailable, "cancelled")
		if err != nil {
			return err
		}
	}
	if arrival.State == ArrivalUnavailable || arrival.State == ArrivalRejected || arrival.State == ArrivalLeft {
		return nil
	}
	if arrival.State != ArrivalAdmitted {
		return ErrArrivalUnavailable
	}
	if err := r.access.RevokePublicAccess(ctx, PublicAccessInput{Arrival: arrival}); err != nil {
		return err
	}
	_, err = r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
		TenantID:              arrival.TenantID,
		ArrivalHandle:         arrival.ArrivalHandle,
		State:                 ArrivalLeft,
		Reason:                "left",
		EpisodeID:             arrival.EpisodeID,
		ParticipantID:         arrival.ParticipantID,
		ParticipantGeneration: arrival.ParticipantGeneration,
		Provider:              arrival.Provider,
		ProviderSubject:       arrival.ProviderSubject,
	})
	return err
}

func validateAccessGrant(grant PublicAccessGrant, arrival Arrival) error {
	if grant.TenantID != arrival.TenantID || grant.SpaceID != arrival.SpaceID || grant.EpisodeID.IsZero() || grant.ParticipantID.IsZero() || grant.ParticipantGeneration <= 0 {
		return ErrArrivalUnavailable
	}
	if err := validateProviderBinding(grant.Provider, grant.ProviderSubject, true); err != nil {
		return err
	}
	if err := validateClientPayload(grant); err != nil {
		return err
	}
	return nil
}
