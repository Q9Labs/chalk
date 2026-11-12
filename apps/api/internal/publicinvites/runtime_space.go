package publicinvites

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r Runtime) CreatePublicSpace(ctx context.Context, input CreatePublicSpaceInput) (PublicSpaceCreated, error) {
	name, err := validateCreatePublicSpaceInput(input)
	if err != nil {
		return PublicSpaceCreated{}, err
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
	inviteLink, err := r.inviteLink(input.LegacyInviteLink, space, invite)
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	created, err := r.creatorArrival(ctx, space, invite, name, input.RequestKey)
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	arrival, grant, err := r.admitCreator(ctx, created.Arrival, input.MediaClients)
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	lifecycle, err := r.service.CreateAutoLifecycle(ctx, AutoLifecycle{
		TenantID:             space.TenantID,
		SpaceID:              space.SpaceID,
		DeadlineAt:           r.service.now().Add(r.autoLifecycleLifetime),
		CreatorArrivalHandle: created.Arrival.ArrivalHandle,
	})
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	arrivalResponse := r.arrivalResult(space, arrival)
	arrivalResponse.Access = &grant
	return PublicSpaceCreated{
		Presentation:    publicSpacePresentation(space),
		InviteLink:      inviteLink,
		LifecycleUntil:  lifecycle.DeadlineAt,
		Arrival:         arrivalResponse,
		GuestCredential: base64.RawURLEncoding.EncodeToString(created.Credential),
	}, nil
}

func validateCreatePublicSpaceInput(input CreatePublicSpaceInput) (string, error) {
	name := strings.TrimSpace(input.DisplayName)
	if err := validateDisplayName(name); err != nil {
		return "", err
	}
	if input.RequestKey == "" {
		return "", ErrInvalidRequestKey
	}
	if err := validateIdempotencyKey(input.RequestKey); err != nil {
		return "", ErrInvalidRequestKey
	}
	return name, nil
}

func (r Runtime) inviteLink(legacy bool, space PublicSpace, invite Invite) (string, error) {
	var link string
	var err error
	if legacy {
		var token string
		if token, err = r.service.IssueInviteToken(invite); err != nil {
			return "", err
		}
		link, err = r.links.LegacyInviteURL(space.Slug, token)
	} else {
		link, err = r.links.InviteURL(InviteWordCode(invite.Handle))
	}
	if err != nil {
		return "", fmt.Errorf("build public Space invite link: %w", err)
	}
	return link, nil
}

// creatorArrival records the creator's guest Arrival, or finds the one an
// earlier request with the same key made.
func (r Runtime) creatorArrival(ctx context.Context, space PublicSpace, invite Invite, name, key string) (CreateArrivalResult, error) {
	token := Token{Handle: invite.Handle, Generation: invite.Generation}
	guestCredential, err := r.deriveGuestCredential(token, key)
	if err != nil {
		return CreateArrivalResult{}, err
	}
	var created CreateArrivalResult
	existing, err := r.service.GetArrivalByIdempotency(ctx, space.TenantID, space.SpaceID, key)
	switch {
	case err == nil:
		if existing.IdentityMode != IdentityGuest || existing.DisplayName != name || existing.IdempotencyKey != key ||
			!bytes.Equal(existing.InviteHandle, invite.Handle) || existing.InviteGeneration != invite.Generation || existing.InviteStateEpoch != invite.StateEpoch {
			return CreateArrivalResult{}, ErrIdempotencyConflict
		}
		created.Arrival = existing
	case errors.Is(err, ErrArrivalNotFound):
		created, err = r.service.CreateArrival(ctx, CreateArrivalInput{
			TenantID:         space.TenantID,
			SpaceID:          space.SpaceID,
			Invite:           token,
			InviteStateEpoch: invite.StateEpoch,
			IdentityMode:     IdentityGuest,
			DisplayName:      name,
			GuestCredential:  guestCredential,
			IdempotencyKey:   key,
		})
		if err != nil {
			return CreateArrivalResult{}, err
		}
	default:
		return CreateArrivalResult{}, err
	}
	if created.Arrival.IdentityMode == IdentityGuest && len(created.Credential) == 0 {
		created.Credential = append([]byte(nil), guestCredential...)
	}
	return created, nil
}

// admitCreator grants the creator media access and records the Arrival as admitted.
func (r Runtime) admitCreator(ctx context.Context, arrival Arrival, clients mediaplane.ClientProviders) (Arrival, PublicAccessGrant, error) {
	if arrival.State != ArrivalAdmitted && arrival.State != ArrivalPending {
		return Arrival{}, PublicAccessGrant{}, ErrArrivalUnavailable
	}
	grant, err := r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrival, MediaClients: clients})
	if err != nil {
		return Arrival{}, PublicAccessGrant{}, err
	}
	if arrival.State == ArrivalPending {
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
		if err != nil {
			return Arrival{}, PublicAccessGrant{}, err
		}
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		return Arrival{}, PublicAccessGrant{}, err
	}
	return arrival, grant, nil
}

func publicSpacePresentation(space PublicSpace) PublicSpacePresentation {
	return PublicSpacePresentation{Name: space.Name, Slug: space.Slug, AdmissionMode: space.AdmissionMode, MaximumEpisodeDurationSeconds: space.MaximumEpisodeDurationSeconds}
}

func validatePublicSpace(space PublicSpace) error {
	if space.TenantID.IsZero() || space.SpaceID.IsZero() || !space.AdmissionMode.valid() {
		return ErrInvalidInvite
	}
	// The name only appears in JSON, so any name a Space accepts is valid. The
	// slug is a path segment of the invite link, which mobile clients parse as
	// ASCII, so it stays ASCII.
	if strings.TrimSpace(space.Name) == "" || strings.TrimSpace(space.Slug) == "" || !isASCII(space.Slug) {
		return ErrInvalidInvite
	}
	return nil
}
