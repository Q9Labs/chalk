package publicinvites

import (
	"context"
	"errors"
	"fmt"
)

// grantArrival grants the arrival access to the Space with the role that arrivalRole decides.
func (r Runtime) grantArrival(ctx context.Context, space PublicSpace, input PublicInviteArrivalInput, arrival Arrival) (PublicAccessGrant, error) {
	role, err := r.arrivalRole(ctx, space, input)
	if err != nil {
		return PublicAccessGrant{}, err
	}
	return r.access.GrantPublicAccess(ctx, PublicAccessInput{Role: role, Arrival: arrival, MediaClients: input.MediaClients})
}

// arrivalRole is owner for the person who started this public call, who arrives again after a Leave or a lost seat,
// and collaborator for everyone else. A rejoin is a new arrival, so the starter is known by the credential of the
// arrival that created the Space: the guest credential of a native client, or the starter credential of a browser.
func (r Runtime) arrivalRole(ctx context.Context, space PublicSpace, input PublicInviteArrivalInput) (string, error) {
	lifecycle, err := r.service.GetAutoLifecycle(ctx, space.TenantID, space.SpaceID)
	if errors.Is(err, ErrAutoLifecycleNotFound) || (err == nil && lifecycle.CreatorArrivalHandle.IsZero()) {
		return PublicRoleCollaborator, nil
	}
	if err != nil {
		return "", fmt.Errorf("read the starter of public Space: %w", err)
	}
	for _, presented := range []string{input.StarterCredentials[lifecycle.CreatorArrivalHandle.String()], input.GuestCredential} {
		credential, decodeErr := decodeGuestCredential(presented)
		if decodeErr != nil || len(credential) == 0 {
			continue
		}
		_, err := r.service.GetArrivalForCredential(ctx, lifecycle.CreatorArrivalHandle, credential)
		if err == nil {
			return PublicRoleOwner, nil
		}
		if !errors.Is(err, ErrCredentialMismatch) && !errors.Is(err, ErrInvalidCredential) {
			return "", fmt.Errorf("check the starter of public Space: %w", err)
		}
	}
	return PublicRoleCollaborator, nil
}
