package publicinvites

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

func (s Service) EnsureInvite(ctx context.Context, tenantID, spaceID, actorID utilities.ID, mode AdmissionMode) (Invite, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return Invite{}, err
	}
	if !mode.valid() {
		return Invite{}, ErrInvalidAdmissionMode
	}
	created, err := withFreshInviteHandle("generate public invite handle", func(handle []byte) (Invite, error) {
		return s.repository.CreateOrGetInvite(ctx, Invite{
			TenantID:      tenantID,
			SpaceID:       spaceID,
			Handle:        handle,
			Generation:    1,
			StateEpoch:    1,
			Enabled:       true,
			PublicRole:    PublicRoleCollaborator,
			AdmissionMode: mode,
			LastActorID:   actorID,
		})
	})
	if err != nil {
		return Invite{}, err
	}
	if err := validateInvite(created); err != nil {
		return Invite{}, err
	}
	return created, nil
}

func (s Service) GetInvite(ctx context.Context, tenantID, spaceID utilities.ID) (Invite, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return Invite{}, err
	}
	invite, err := s.repository.GetInvite(ctx, tenantID, spaceID)
	if err != nil {
		return Invite{}, err
	}
	if err := validateInvite(invite); err != nil {
		return Invite{}, err
	}
	return invite, nil
}

func (s Service) SetInviteEnabled(ctx context.Context, tenantID, spaceID utilities.ID, enabled bool, actorID utilities.ID) (Invite, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return Invite{}, err
	}
	invite, err := s.repository.SetInviteEnabled(ctx, tenantID, spaceID, enabled, actorID)
	if err != nil {
		return Invite{}, err
	}
	if err := validateInvite(invite); err != nil {
		return Invite{}, err
	}
	return invite, nil
}

func (s Service) RotateInvite(ctx context.Context, tenantID, spaceID, actorID utilities.ID, requestKey string) (Invite, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return Invite{}, err
	}
	if requestKey != "" {
		if err := validateIdempotencyKey(requestKey); err != nil {
			return Invite{}, ErrInvalidRequestKey
		}
	}
	invite, err := withFreshInviteHandle("generate rotated public invite handle", func(handle []byte) (Invite, error) {
		return s.repository.RotateInvite(ctx, tenantID, spaceID, handle, actorID, requestKey)
	})
	if err != nil {
		return Invite{}, err
	}
	if err := validateInvite(invite); err != nil {
		return Invite{}, err
	}
	return invite, nil
}

func (s Service) IssueInviteToken(invite Invite) (string, error) {
	if err := validateInvite(invite); err != nil {
		return "", err
	}
	if s.signer == nil {
		return "", ErrInvalidKeyring
	}
	token, err := s.signer.Issue(invite.Handle, invite.Generation)
	if err != nil {
		return "", err
	}
	return s.signer.Encode(token)
}

func (s Service) ResolveInviteToken(ctx context.Context, raw string) (Invite, Token, error) {
	if code, ok := ParseInviteCode(raw); ok {
		trace.SpanFromContext(ctx).SetAttributes(attribute.String("chalk.public_invite.credential", "code"))
		invite, err := s.repository.GetInviteByCode(ctx, code)
		if errors.Is(err, ErrInviteNotFound) {
			return Invite{}, Token{}, ErrInviteUnavailable
		}
		if err != nil {
			return Invite{}, Token{}, err
		}
		if err := validateInvite(invite); err != nil || !invite.Enabled {
			return Invite{}, Token{}, ErrInviteUnavailable
		}
		return invite, Token{Handle: invite.Handle, Generation: invite.Generation}, nil
	}
	trace.SpanFromContext(ctx).SetAttributes(attribute.String("chalk.public_invite.credential", "token"))
	if s.signer == nil {
		return Invite{}, Token{}, ErrInvalidKeyring
	}
	token, err := s.signer.Verify(raw)
	if err != nil {
		return Invite{}, Token{}, err
	}
	invite, err := s.repository.GetInviteByHandle(ctx, token.Handle)
	if errors.Is(err, ErrInviteNotFound) {
		return Invite{}, Token{}, ErrInviteUnavailable
	}
	if err != nil {
		return Invite{}, Token{}, err
	}
	if err := validateInvite(invite); err != nil {
		return Invite{}, Token{}, ErrInviteUnavailable
	}
	if !invite.Enabled || invite.Generation != token.Generation || !bytes.Equal(invite.Handle, token.Handle) {
		return Invite{}, Token{}, ErrInviteUnavailable
	}
	return invite, token, nil
}

func withFreshInviteHandle(generationError string, attempt func([]byte) (Invite, error)) (Invite, error) {
	err := ErrInviteCodeTaken
	for range 3 {
		handle := make([]byte, HandleBytes)
		if _, readErr := rand.Read(handle); readErr != nil {
			return Invite{}, fmt.Errorf("%s: %w", generationError, readErr)
		}
		var invite Invite
		invite, err = attempt(handle)
		if !errors.Is(err, ErrInviteCodeTaken) {
			return invite, err
		}
	}
	return Invite{}, err
}

type inviteCredential struct {
	code  string
	token Token
}

func (s Service) parseInviteCredential(raw string) (inviteCredential, error) {
	if code, ok := ParseInviteCode(raw); ok {
		return inviteCredential{code: code}, nil
	}
	if s.signer == nil {
		return inviteCredential{}, ErrInvalidKeyring
	}
	token, err := s.signer.Verify(raw)
	if err != nil {
		return inviteCredential{}, err
	}
	return inviteCredential{token: token}, nil
}

func (credential inviteCredential) matches(handle []byte, generation uint64) bool {
	if credential.code != "" {
		return InviteCode(handle) == credential.code || InviteWordCode(handle) == credential.code
	}
	return credential.token.Generation == generation && bytes.Equal(credential.token.Handle, handle)
}
