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
