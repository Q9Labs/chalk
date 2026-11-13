package publicinvites

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r Runtime) Arrive(ctx context.Context, input PublicInviteArrivalInput) (PublicSpaceArrival, error) {
	name, err := validateArrivalInput(input)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	credential, err := r.service.parseInviteCredential(strings.TrimSpace(input.Token))
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if strings.TrimSpace(input.ArrivalHandle) != "" {
		return r.resumeArrival(ctx, input, credential)
	}
	return r.newArrival(ctx, input, name)
}

// validateArrivalInput checks the fields a caller controls and returns the
// trimmed display name. A first arrival needs an idempotency key; a resumed one
// is named by its handle.
func validateArrivalInput(input PublicInviteArrivalInput) (string, error) {
	name := strings.TrimSpace(input.DisplayName)
	resuming := strings.TrimSpace(input.ArrivalHandle) != ""
	if !resuming && name != "" {
		if err := validateDisplayName(name); err != nil {
			return "", err
		}
	}
	if input.RequestKey == "" && !resuming {
		return "", ErrInvalidIdempotencyKey
	}
	if input.RequestKey != "" {
		if err := validateIdempotencyKey(input.RequestKey); err != nil {
			return "", err
		}
	}
	return name, nil
}

// loadPublicSpace reads the Space an Arrival or invite names and refuses a
// Space that is not the one asked for.
func (r Runtime) loadPublicSpace(ctx context.Context, tenantID, spaceID utilities.ID) (PublicSpace, error) {
	space, err := r.space.GetPublicSpace(ctx, tenantID, spaceID)
	if err != nil {
		return PublicSpace{}, err
	}
	if space.TenantID != tenantID || space.SpaceID != spaceID {
		return PublicSpace{}, ErrInviteUnavailable
	}
	return space, nil
}

// resumeArrival answers a caller that already holds an Arrival handle.
func (r Runtime) resumeArrival(ctx context.Context, input PublicInviteArrivalInput, credential inviteCredential) (PublicSpaceArrival, error) {
	arrival, err := r.authenticateArrival(ctx, input.ArrivalHandle, input.GuestCredential, input.AccountID)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if !credential.matches(arrival.InviteHandle, arrival.InviteGeneration) {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	space, err := r.loadPublicSpace(ctx, arrival.TenantID, arrival.SpaceID)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if space.Archived && arrival.State != ArrivalAdmitted {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	if arrival.State == ArrivalPending && arrival.IdentityMode == IdentityGuest {
		if arrival, err = r.dropStalePendingGuest(ctx, arrival, space, nil); err != nil {
			return PublicSpaceArrival{}, err
		}
	}
	switch {
	case arrival.State == ArrivalAdmitted:
		return r.resumeAdmittedArrival(ctx, space, arrival, input.MediaClients)
	case arrival.State == ArrivalPending && (arrival.IdentityMode == IdentityAccount || space.AdmissionMode == AdmissionOpen):
		return r.grantAndAdmit(ctx, space, arrival, input.MediaClients)
	}
	return r.arrivalResult(space, arrival), nil
}

// newArrival records a first arrival through an invite token. The guest
// credential is returned on every outcome so the guest can resume later.
func (r Runtime) newArrival(ctx context.Context, input PublicInviteArrivalInput, name string) (PublicSpaceArrival, error) {
	invite, token, err := r.service.ResolveInviteToken(ctx, strings.TrimSpace(input.Token))
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	space, accountAuthorized, err := r.arrivalSpace(ctx, input, invite)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	create, err := r.arrivalInput(input, invite, token, name, accountAuthorized)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	created, err := r.service.CreateArrival(ctx, create)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if create.IdentityMode == IdentityGuest && len(created.Credential) == 0 {
		created.Credential = append([]byte(nil), create.GuestCredential...)
	}
	result, err := r.admitNewArrival(ctx, input, name, space, created.Arrival, accountAuthorized)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	result.GuestCredential = base64.RawURLEncoding.EncodeToString(created.Credential)
	return result, nil
}

// arrivalSpace loads the invite's Space and reports whether the caller's account may enter it as a member.
func (r Runtime) arrivalSpace(ctx context.Context, input PublicInviteArrivalInput, invite Invite) (PublicSpace, bool, error) {
	space, err := r.loadPublicSpace(ctx, invite.TenantID, invite.SpaceID)
	if err != nil {
		return PublicSpace{}, false, err
	}
	if space.Archived {
		return PublicSpace{}, false, ErrInviteUnavailable
	}
	accountAuthorized, err := r.authorizeAccount(ctx, input.AccountID, invite.TenantID)
	if err != nil {
		return PublicSpace{}, false, err
	}
	if space.AdmissionMode == AdmissionMembersOnly && !accountAuthorized {
		return PublicSpace{}, false, ErrInviteUnavailable
	}
	return space, accountAuthorized, nil
}

// arrivalInput builds the Arrival record for an account member or a guest; a guest without a credential gets a derived one.
func (r Runtime) arrivalInput(input PublicInviteArrivalInput, invite Invite, token Token, name string, accountAuthorized bool) (CreateArrivalInput, error) {
	create := CreateArrivalInput{
		TenantID:         invite.TenantID,
		SpaceID:          invite.SpaceID,
		Invite:           token,
		InviteStateEpoch: invite.StateEpoch,
		IdentityMode:     IdentityGuest,
		DisplayName:      name,
		IdempotencyKey:   input.RequestKey,
	}
	if accountAuthorized {
		create.IdentityMode, create.AccountID = IdentityAccount, input.AccountID
	}
	var err error
	if create.GuestCredential, err = decodeGuestCredential(input.GuestCredential); err != nil {
		return CreateArrivalInput{}, err
	}
	if create.IdentityMode == IdentityGuest && len(create.GuestCredential) == 0 {
		if create.GuestCredential, err = r.deriveGuestCredential(token, input.RequestKey); err != nil {
			return CreateArrivalInput{}, err
		}
	}
	return create, nil
}

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

func (r Runtime) ArrivalStatus(ctx context.Context, input PublicInviteArrivalStatusInput, beforeWrite func() error) (PublicSpaceArrival, error) {
	arrival, err := r.authenticateArrival(ctx, input.ArrivalHandle, input.GuestCredential, input.AccountID)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	space, err := r.loadPublicSpace(ctx, arrival.TenantID, arrival.SpaceID)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if arrival.State == ArrivalPending && arrival.IdentityMode == IdentityGuest {
		if result, resolved, err := r.resolvePendingAdmission(ctx, space, arrival, input.MediaClients, beforeWrite); resolved || err != nil {
			return result, err
		}
		if arrival, err = r.dropStalePendingGuest(ctx, arrival, space, beforeWrite); err != nil {
			return PublicSpaceArrival{}, err
		}
	}
	if arrival.State != ArrivalAdmitted {
		return r.arrivalResult(space, arrival), nil
	}
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

func (r Runtime) authenticateArrival(ctx context.Context, rawHandle, credential string, accountID utilities.ID) (Arrival, error) {
	handle, err := utilities.ParseID(strings.TrimSpace(rawHandle))
	if err != nil {
		return Arrival{}, ErrArrivalNotFound
	}
	arrival, getErr := r.service.GetArrival(ctx, handle)
	if getErr != nil {
		return Arrival{}, getErr
	}
	if !accountID.IsZero() {
		authorized, authErr := r.authorizeAccount(ctx, accountID, arrival.TenantID)
		if authErr != nil {
			return Arrival{}, authErr
		}
		if authorized {
			if arrival.IdentityMode != IdentityAccount || arrival.AccountID != accountID {
				return Arrival{}, ErrCredentialMismatch
			}
			return arrival, nil
		}
	}
	credentialBytes, credentialErr := decodeGuestCredential(credential)
	if credentialErr != nil {
		return Arrival{}, credentialErr
	}
	return r.service.GetArrivalForCredential(ctx, handle, credentialBytes)
}

func (r Runtime) arrivalResult(space PublicSpace, arrival Arrival) PublicSpaceArrival {
	result := PublicSpaceArrival{
		State:         arrival.State,
		Identity:      arrival.IdentityMode,
		ArrivalHandle: arrival.ArrivalHandle.String(),
	}
	if arrival.State == ArrivalPending {
		result.RetryAfter = 2
	}
	presentation := publicSpacePresentation(space)
	result.Presentation = &presentation
	return result
}
