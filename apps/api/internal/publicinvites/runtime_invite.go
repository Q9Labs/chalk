package publicinvites

import (
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r Runtime) GetInvite(ctx context.Context, tenantID, spaceID utilities.ID, beforeCreate func() error) (ManagedInvite, error) {
	invite, err := r.service.GetInvite(ctx, tenantID, spaceID)
	if errors.Is(err, ErrInviteNotFound) {
		if err := beforeCreate(); err != nil {
			return ManagedInvite{}, err
		}
		invite, err = r.ensureInviteForSpace(ctx, tenantID, spaceID)
	}
	if err != nil {
		return ManagedInvite{}, err
	}
	return r.managedInvite(ctx, invite)
}

func (r Runtime) ensureInviteForSpace(ctx context.Context, tenantID, spaceID utilities.ID) (Invite, error) {
	space, err := r.space.GetPublicSpace(ctx, tenantID, spaceID)
	if err != nil {
		return Invite{}, err
	}
	if err := validatePublicSpace(space); err != nil {
		return Invite{}, err
	}
	if space.TenantID != tenantID || space.SpaceID != spaceID {
		return Invite{}, ErrInviteUnavailable
	}
	return r.service.EnsureInvite(ctx, tenantID, spaceID, utilities.ID{}, space.AdmissionMode)
}

func (r Runtime) UpdateInvite(ctx context.Context, input UpdateSpacePublicInviteInput) (ManagedInvite, error) {
	invite, err := r.service.SetInviteEnabled(ctx, input.TenantID, input.SpaceID, input.Enabled, input.ActorID)
	if errors.Is(err, ErrInviteNotFound) {
		if _, ensureErr := r.ensureInviteForSpace(ctx, input.TenantID, input.SpaceID); ensureErr != nil {
			return ManagedInvite{}, ensureErr
		}
		invite, err = r.service.SetInviteEnabled(ctx, input.TenantID, input.SpaceID, input.Enabled, input.ActorID)
	}
	if err != nil {
		return ManagedInvite{}, err
	}
	return r.managedInvite(ctx, invite)
}

func (r Runtime) RotateInvite(ctx context.Context, input RotateSpacePublicInviteInput) (ManagedInvite, error) {
	if input.RequestKey != "" {
		if err := validateIdempotencyKey(input.RequestKey); err != nil {
			return ManagedInvite{}, ErrInvalidRequestKey
		}
	}
	invite, err := r.service.RotateInvite(ctx, input.TenantID, input.SpaceID, input.ActorID, input.RequestKey)
	if errors.Is(err, ErrInviteNotFound) {
		if _, ensureErr := r.ensureInviteForSpace(ctx, input.TenantID, input.SpaceID); ensureErr != nil {
			return ManagedInvite{}, ensureErr
		}
		invite, err = r.service.RotateInvite(ctx, input.TenantID, input.SpaceID, input.ActorID, input.RequestKey)
	}
	if err != nil {
		return ManagedInvite{}, err
	}
	return r.managedInvite(ctx, invite)
}

func (r Runtime) managedInvite(ctx context.Context, invite Invite) (ManagedInvite, error) {
	if err := validateInvite(invite); err != nil {
		return ManagedInvite{}, err
	}
	space, err := r.space.GetPublicSpace(ctx, invite.TenantID, invite.SpaceID)
	if err != nil {
		return ManagedInvite{}, err
	}
	if err := validatePublicSpace(space); err != nil {
		return ManagedInvite{}, err
	}
	if space.TenantID != invite.TenantID || space.SpaceID != invite.SpaceID {
		return ManagedInvite{}, ErrInviteUnavailable
	}
	canonicalURL, err := r.links.InviteURL(InviteWordCode(invite.Handle))
	if err != nil {
		return ManagedInvite{}, err
	}
	return ManagedInvite{Invite: invite, CanonicalURL: canonicalURL}, nil
}
