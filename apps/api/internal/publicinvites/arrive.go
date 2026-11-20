package publicinvites

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r Runtime) Arrive(ctx context.Context, input PublicInviteArrivalInput) (PublicSpaceArrival, error) {
	name := strings.TrimSpace(input.DisplayName)
	if strings.TrimSpace(input.ArrivalHandle) == "" && name != "" {
		if err := validateDisplayName(name); err != nil {
			return PublicSpaceArrival{}, err
		}
	}
	if input.RequestKey == "" && strings.TrimSpace(input.ArrivalHandle) == "" {
		return PublicSpaceArrival{}, ErrInvalidIdempotencyKey
	}
	if input.RequestKey != "" {
		if err := validateIdempotencyKey(input.RequestKey); err != nil {
			return PublicSpaceArrival{}, err
		}
	}
	credential, err := r.service.parseInviteCredential(strings.TrimSpace(input.Token))
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if strings.TrimSpace(input.ArrivalHandle) != "" {
		return r.resumeArrival(ctx, input, credential)
	}
	return r.arriveWithInvite(ctx, input, name)
}

func (r Runtime) resumeArrival(ctx context.Context, input PublicInviteArrivalInput, credential inviteCredential) (PublicSpaceArrival, error) {
	arrival, authErr := r.authenticateArrival(ctx, input.ArrivalHandle, input.GuestCredential, input.AccountID)
	if authErr != nil {
		return PublicSpaceArrival{}, authErr
	}
	if !credential.matches(arrival.InviteHandle, arrival.InviteGeneration) {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	space, spaceErr := r.space.GetPublicSpace(ctx, arrival.TenantID, arrival.SpaceID)
	if spaceErr != nil {
		return PublicSpaceArrival{}, spaceErr
	}
	if space.TenantID != arrival.TenantID || space.SpaceID != arrival.SpaceID {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	if space.Archived && arrival.State != ArrivalAdmitted {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	arrival, err := r.revalidateResumedArrival(ctx, space, arrival)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	switch {
	case arrival.State == ArrivalAdmitted:
		return r.resumeAdmittedArrival(ctx, space, arrival, input.MediaClients)
	case arrival.State == ArrivalPending && (arrival.IdentityMode == IdentityAccount || space.AdmissionMode == AdmissionOpen):
		return r.grantResumedArrival(ctx, space, arrival, input.MediaClients)
	default:
		return r.arrivalResult(space, arrival), nil
	}
}

func (r Runtime) revalidateResumedArrival(ctx context.Context, space PublicSpace, arrival Arrival) (Arrival, error) {
	if arrival.State != ArrivalPending || arrival.IdentityMode != IdentityGuest {
		return arrival, nil
	}
	valid, err := r.pendingGuestArrivalValid(ctx, arrival, space)
	if err != nil {
		return Arrival{}, err
	}
	if !valid {
		return r.invalidatePendingArrival(ctx, arrival)
	}
	return arrival, nil
}

func (r Runtime) grantResumedArrival(ctx context.Context, space PublicSpace, arrival Arrival, clients mediaplane.ClientProviders) (PublicSpaceArrival, error) {
	grant, grantErr := r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrival, MediaClients: clients})
	if grantErr != nil {
		return PublicSpaceArrival{}, grantErr
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		return PublicSpaceArrival{}, err
	}
	admitted, updateErr := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
		TenantID:              arrival.TenantID,
		ArrivalHandle:         arrival.ArrivalHandle,
		State:                 ArrivalAdmitted,
		EpisodeID:             grant.EpisodeID,
		ParticipantID:         grant.ParticipantID,
		ParticipantGeneration: grant.ParticipantGeneration,
		Provider:              grant.Provider,
		ProviderSubject:       grant.ProviderSubject,
	})
	if updateErr != nil {
		return PublicSpaceArrival{}, updateErr
	}
	result := r.arrivalResult(space, admitted)
	result.Access = &grant
	return result, nil
}

func (r Runtime) arriveWithInvite(ctx context.Context, input PublicInviteArrivalInput, name string) (PublicSpaceArrival, error) {
	invite, token, resolveErr := r.service.ResolveInviteToken(ctx, strings.TrimSpace(input.Token))
	if resolveErr != nil {
		return PublicSpaceArrival{}, resolveErr
	}
	if input.RequestKey == "" {
		return PublicSpaceArrival{}, ErrInvalidIdempotencyKey
	}
	space, err := r.space.GetPublicSpace(ctx, invite.TenantID, invite.SpaceID)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if space.TenantID != invite.TenantID || space.SpaceID != invite.SpaceID {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	if space.Archived {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	accountAuthorized, err := r.authorizeAccount(ctx, input.AccountID, invite.TenantID)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if space.AdmissionMode == AdmissionMembersOnly && !accountAuthorized {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	arrivalResult, err := r.createInviteArrival(ctx, invite, token, input, name, accountAuthorized)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	var result PublicSpaceArrival
	switch {
	case accountAuthorized || space.AdmissionMode == AdmissionOpen:
		result, err = r.accessForInviteArrival(ctx, invite, space, input, arrivalResult.Arrival)
	case space.AdmissionMode == AdmissionKnock:
		result, err = r.knockWithInvite(ctx, space, input, arrivalResult.Arrival, name)
	default:
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	result.GuestCredential = base64.RawURLEncoding.EncodeToString(arrivalResult.Credential)
	return result, nil
}

func (r Runtime) createInviteArrival(ctx context.Context, invite Invite, token Token, input PublicInviteArrivalInput, name string, accountAuthorized bool) (CreateArrivalResult, error) {
	var err error
	identityMode := IdentityGuest
	if accountAuthorized {
		identityMode = IdentityAccount
	}
	arrivalAccountID := utilities.ID{}
	if accountAuthorized {
		arrivalAccountID = input.AccountID
	}
	guestCredential, credentialErr := decodeGuestCredential(input.GuestCredential)
	if credentialErr != nil {
		return CreateArrivalResult{}, credentialErr
	}
	if identityMode == IdentityGuest && len(guestCredential) == 0 {
		guestCredential, err = r.deriveGuestCredential(token, input.RequestKey)
		if err != nil {
			return CreateArrivalResult{}, err
		}
	}
	arrivalResult, err := r.service.CreateArrival(ctx, CreateArrivalInput{
		TenantID:         invite.TenantID,
		SpaceID:          invite.SpaceID,
		Invite:           token,
		InviteStateEpoch: invite.StateEpoch,
		IdentityMode:     identityMode,
		AccountID:        arrivalAccountID,
		DisplayName:      name,
		GuestCredential:  guestCredential,
		IdempotencyKey:   input.RequestKey,
	})
	if err != nil {
		return CreateArrivalResult{}, err
	}
	if identityMode == IdentityGuest && len(arrivalResult.Credential) == 0 {
		arrivalResult.Credential = append([]byte(nil), guestCredential...)
	}
	return arrivalResult, nil
}

func (r Runtime) accessForInviteArrival(ctx context.Context, invite Invite, space PublicSpace, input PublicInviteArrivalInput, arrival Arrival) (PublicSpaceArrival, error) {
	if arrival.State != ArrivalPending && arrival.State != ArrivalAdmitted {
		return PublicSpaceArrival{}, ErrArrivalUnavailable
	}
	grant, err := r.grantArrival(ctx, space, input, arrival)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		return PublicSpaceArrival{}, err
	}
	if arrival.State == ArrivalPending {
		var updateErr error
		arrival, updateErr = r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
			TenantID:              invite.TenantID,
			ArrivalHandle:         arrival.ArrivalHandle,
			State:                 ArrivalAdmitted,
			EpisodeID:             grant.EpisodeID,
			ParticipantID:         grant.ParticipantID,
			ParticipantGeneration: grant.ParticipantGeneration,
			Provider:              grant.Provider,
			ProviderSubject:       grant.ProviderSubject,
		})
		if updateErr != nil {
			return PublicSpaceArrival{}, updateErr
		}
	}
	result := r.arrivalResult(space, arrival)
	result.Access = &grant
	return result, nil
}

func (r Runtime) knockWithInvite(ctx context.Context, space PublicSpace, input PublicInviteArrivalInput, arrival Arrival, name string) (PublicSpaceArrival, error) {
	if arrival.State == ArrivalAdmitted {
		return r.resumeAdmittedArrival(ctx, space, arrival, input.MediaClients)
	}
	if arrival.State != ArrivalPending {
		return r.arrivalResult(space, arrival), nil
	}
	_, requestErr := r.service.CreateAdmissionRequest(ctx, CreateAdmissionRequestInput{ArrivalHandle: arrival.ArrivalHandle, DisplayName: name, MediaClients: input.MediaClients})
	if errors.Is(requestErr, ErrArrivalUnavailable) {
		terminal, terminalErr := r.invalidatePendingArrival(ctx, arrival)
		if terminalErr != nil {
			return PublicSpaceArrival{}, terminalErr
		}
		result := r.arrivalResult(space, terminal)
		return result, nil
	}
	if requestErr != nil {
		return PublicSpaceArrival{}, requestErr
	}
	result := r.arrivalResult(space, arrival)
	result.RetryAfter = 2
	return result, nil
}
