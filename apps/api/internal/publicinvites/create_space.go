package publicinvites

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/calllength"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r Runtime) CreatePublicSpace(ctx context.Context, input CreatePublicSpaceInput) (PublicSpaceCreated, error) {
	name := strings.TrimSpace(input.DisplayName)
	if err := validateDisplayName(name); err != nil {
		return PublicSpaceCreated{}, err
	}
	if input.RequestKey == "" {
		return PublicSpaceCreated{}, ErrInvalidRequestKey
	}
	if err := validateIdempotencyKey(input.RequestKey); err != nil {
		return PublicSpaceCreated{}, ErrInvalidRequestKey
	}
	input.DisplayName = name
	space, err := r.space.CreatePublicSpace(ctx, input)
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	if err := validatePublicSpace(space); err != nil {
		return PublicSpaceCreated{}, err
	}
	if space.Archived {
		return PublicSpaceCreated{}, ErrInviteUnavailable
	}
	invite, err := r.service.EnsureInvite(ctx, space.TenantID, space.SpaceID, utilities.ID{}, space.AdmissionMode)
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	inviteLink, err := r.createdSpaceInviteLink(space, invite, input.LegacyInviteLink)
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	arrivalResult, err := r.createOwnerArrival(ctx, space, invite, input.RequestKey, name)
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	arrival, grant, err := r.grantOwnerAccess(ctx, arrivalResult.Arrival, input.MediaClients)
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	deadline := r.service.now().Add(calllength.Anonymous.MaximumLifetime())
	lifecycle, err := r.service.CreateAutoLifecycle(ctx, AutoLifecycle{
		TenantID:             space.TenantID,
		SpaceID:              space.SpaceID,
		DeadlineAt:           deadline,
		CreatorArrivalHandle: arrivalResult.Arrival.ArrivalHandle,
	})
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	deadline = lifecycle.DeadlineAt
	presentation := publicSpacePresentation(space)
	arrivalResponse := r.arrivalResult(space, arrival)
	arrivalResponse.Access = &grant
	return PublicSpaceCreated{
		Presentation:    presentation,
		InviteLink:      inviteLink,
		LifecycleUntil:  deadline,
		Arrival:         arrivalResponse,
		GuestCredential: base64.RawURLEncoding.EncodeToString(arrivalResult.Credential),
	}, nil
}

func (r Runtime) createdSpaceInviteLink(space PublicSpace, invite Invite, legacy bool) (string, error) {
	var err error
	var inviteLink string
	if legacy {
		token, tokenErr := r.service.IssueInviteToken(invite)
		if tokenErr != nil {
			return "", tokenErr
		}
		inviteLink, err = r.links.LegacyInviteURL(space.Slug, token)
	} else {
		inviteLink, err = r.links.InviteURL(InviteWordCode(invite.Handle))
	}
	if err != nil {
		return "", fmt.Errorf("build public Space invite link: %w", err)
	}
	return inviteLink, nil
}

func (r Runtime) createOwnerArrival(ctx context.Context, space PublicSpace, invite Invite, arrivalKey, name string) (CreateArrivalResult, error) {
	guestCredential, err := r.deriveGuestCredential(Token{Handle: invite.Handle, Generation: invite.Generation}, arrivalKey)
	if err != nil {
		return CreateArrivalResult{}, err
	}
	var arrivalResult CreateArrivalResult
	existing, existingErr := r.service.GetArrivalByIdempotency(ctx, space.TenantID, space.SpaceID, arrivalKey)
	switch {
	case existingErr == nil:
		if existing.IdentityMode != IdentityGuest || existing.DisplayName != name || existing.IdempotencyKey != arrivalKey ||
			!bytes.Equal(existing.InviteHandle, invite.Handle) || existing.InviteGeneration != invite.Generation || existing.InviteStateEpoch != invite.StateEpoch {
			return CreateArrivalResult{}, ErrIdempotencyConflict
		}
		arrivalResult.Arrival = existing
	case errors.Is(existingErr, ErrArrivalNotFound):
		arrivalResult, err = r.service.CreateArrival(ctx, CreateArrivalInput{
			TenantID:         space.TenantID,
			SpaceID:          space.SpaceID,
			Invite:           Token{Handle: invite.Handle, Generation: invite.Generation},
			InviteStateEpoch: invite.StateEpoch,
			IdentityMode:     IdentityGuest,
			DisplayName:      name,
			GuestCredential:  guestCredential,
			IdempotencyKey:   arrivalKey,
		})
		if err != nil {
			return CreateArrivalResult{}, err
		}
	default:
		return CreateArrivalResult{}, existingErr
	}
	if arrivalResult.Arrival.IdentityMode == IdentityGuest && len(arrivalResult.Credential) == 0 {
		arrivalResult.Credential = append([]byte(nil), guestCredential...)
	}
	return arrivalResult, nil
}

func (r Runtime) grantOwnerAccess(ctx context.Context, arrival Arrival, clients mediaplane.ClientProviders) (Arrival, PublicAccessGrant, error) {
	var err error
	var grant PublicAccessGrant
	switch arrival.State {
	case ArrivalAdmitted:
		grant, err = r.access.GrantPublicAccess(ctx, PublicAccessInput{Role: PublicRoleOwner, Arrival: arrival, MediaClients: clients})
	case ArrivalPending:
		grant, err = r.access.GrantPublicAccess(ctx, PublicAccessInput{Role: PublicRoleOwner, Arrival: arrival, MediaClients: clients})
		if err == nil {
			arrival, err = r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
				TenantID:              arrival.TenantID,
				ArrivalHandle:         arrival.ArrivalHandle,
				State:                 ArrivalAdmitted,
				EpisodeID:             grant.EpisodeID,
				ParticipantID:         grant.ParticipantID,
				ParticipantGeneration: grant.ParticipantGeneration,
				Provider:              grant.Provider,
				ProviderSubject:       grant.ProviderSubject,
			})
		}
	default:
		return Arrival{}, PublicAccessGrant{}, ErrArrivalUnavailable
	}
	if err != nil {
		return Arrival{}, PublicAccessGrant{}, err
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		return Arrival{}, PublicAccessGrant{}, err
	}
	return arrival, grant, nil
}
