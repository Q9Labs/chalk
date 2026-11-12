package publicinvites

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// CreateArrival records an Account or Guest arrival and returns a newly
// generated Guest credential only on the first idempotent request.
func (s Service) CreateArrival(ctx context.Context, input CreateArrivalInput) (CreateArrivalResult, error) {
	input, err := validateCreateArrival(input)
	if err != nil {
		return CreateArrivalResult{}, err
	}
	credentialHash, credential, err := prepareCredential(input)
	if err != nil {
		return CreateArrivalResult{}, err
	}
	fingerprint, err := arrivalFingerprint(input, credentialHash)
	if err != nil {
		return CreateArrivalResult{}, err
	}
	existing, err := s.repository.GetArrivalByIdempotency(ctx, input.TenantID, input.SpaceID, input.IdempotencyKey)
	if err == nil {
		return replayArrival(existing, fingerprint)
	}
	if !errors.Is(err, ErrArrivalNotFound) {
		return CreateArrivalResult{}, err
	}

	now := s.now()
	expiresAt := input.ExpiresAt
	if expiresAt.IsZero() {
		expiresAt = now.Add(DefaultArrivalLifetime)
	}
	if !expiresAt.After(now) {
		return CreateArrivalResult{}, ErrArrivalUnavailable
	}
	arrivalHandle, err := utilities.NewID()
	if err != nil {
		return CreateArrivalResult{}, fmt.Errorf("generate public arrival handle: %w", err)
	}
	created, err := s.repository.CreateArrival(ctx, Arrival{
		ArrivalHandle:          arrivalHandle,
		TenantID:               input.TenantID,
		SpaceID:                input.SpaceID,
		InviteHandle:           append([]byte(nil), input.Invite.Handle...),
		InviteGeneration:       input.Invite.Generation,
		InviteStateEpoch:       input.InviteStateEpoch,
		IdentityMode:           input.IdentityMode,
		GuestCredentialHash:    append([]byte(nil), credentialHash...),
		AccountID:              input.AccountID,
		DisplayName:            input.DisplayName,
		CredentialFamily:       input.CredentialFamily,
		IdempotencyKey:         input.IdempotencyKey,
		IdempotencyFingerprint: fingerprint,
		State:                  ArrivalPending,
		ExpiresAt:              expiresAt,
	})
	if errors.Is(err, ErrIdempotencyConflict) {
		// A concurrent request with the same key won the insert.
		winner, lookupErr := s.repository.GetArrivalByIdempotency(ctx, input.TenantID, input.SpaceID, input.IdempotencyKey)
		if lookupErr != nil {
			return CreateArrivalResult{}, lookupErr
		}
		return replayArrival(winner, fingerprint)
	}
	if err != nil {
		return CreateArrivalResult{}, err
	}
	if !bytes.Equal(created.IdempotencyFingerprint[:], fingerprint[:]) {
		return CreateArrivalResult{}, ErrIdempotencyConflict
	}
	return CreateArrivalResult{Arrival: created, Credential: credential}, nil
}

// replayArrival answers a repeated request with the Arrival the first one made,
// unless the repeat differs from it.
func replayArrival(existing Arrival, fingerprint [32]byte) (CreateArrivalResult, error) {
	if !bytes.Equal(existing.IdempotencyFingerprint[:], fingerprint[:]) {
		return CreateArrivalResult{}, ErrIdempotencyConflict
	}
	return CreateArrivalResult{Arrival: existing}, nil
}

// validateCreateArrival checks the input and returns it with a trimmed display name.
func validateCreateArrival(input CreateArrivalInput) (CreateArrivalInput, error) {
	if err := validateIDs(input.TenantID, input.SpaceID); err != nil {
		return input, err
	}
	if len(input.Invite.Handle) != HandleBytes || input.Invite.Generation == 0 || input.InviteStateEpoch == 0 {
		return input, ErrInvalidToken
	}
	if err := validateIdempotencyKey(input.IdempotencyKey); err != nil {
		return input, err
	}
	if input.CredentialFamily != "" && (len(input.CredentialFamily) > MaxCredentialFamilyBytes || !isASCII(input.CredentialFamily)) {
		return input, ErrInvalidArrival
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	return input, validateDisplayName(input.DisplayName)
}

// Arrive preserves the persistence-facing arrival operation for callers that
// do not need the Runtime's token and access orchestration.
func (s Service) Arrive(ctx context.Context, input CreateArrivalInput) (CreateArrivalResult, error) {
	return s.CreateArrival(ctx, input)
}

func prepareCredential(input CreateArrivalInput) ([]byte, []byte, error) {
	switch input.IdentityMode {
	case IdentityAccount:
		if input.AccountID.IsZero() {
			return nil, nil, ErrInvalidAccountID
		}
		if len(input.GuestCredential) != 0 {
			return nil, nil, ErrInvalidIdentityMode
		}
		return nil, nil, nil
	case IdentityGuest:
		if !input.AccountID.IsZero() {
			return nil, nil, ErrInvalidAccountID
		}
		if len(input.GuestCredential) < 16 || len(input.GuestCredential) > 256 {
			return nil, nil, ErrInvalidCredential
		}
		hash := sha256.Sum256(input.GuestCredential)
		return append([]byte(nil), hash[:]...), append([]byte(nil), input.GuestCredential...), nil
	default:
		return nil, nil, ErrInvalidIdentityMode
	}
}

func (s Service) GetArrival(ctx context.Context, arrivalHandle utilities.ID) (Arrival, error) {
	if arrivalHandle.IsZero() {
		return Arrival{}, ErrArrivalNotFound
	}
	return s.repository.GetArrival(ctx, arrivalHandle)
}

func (s Service) GetArrivalByIdempotency(ctx context.Context, tenantID, spaceID utilities.ID, requestKey string) (Arrival, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return Arrival{}, err
	}
	if err := validateIdempotencyKey(requestKey); err != nil {
		return Arrival{}, err
	}
	return s.repository.GetArrivalByIdempotency(ctx, tenantID, spaceID, requestKey)
}

func (s Service) GetArrivalForCredential(ctx context.Context, arrivalHandle utilities.ID, credential []byte) (Arrival, error) {
	if arrivalHandle.IsZero() {
		return Arrival{}, ErrArrivalNotFound
	}
	if len(credential) < 16 || len(credential) > 256 {
		return Arrival{}, ErrInvalidCredential
	}
	hash := sha256.Sum256(credential)
	arrival, err := s.repository.GetArrivalForCredential(ctx, arrivalHandle, hash[:])
	if errors.Is(err, ErrArrivalNotFound) {
		return Arrival{}, ErrCredentialMismatch
	}
	return arrival, err
}

func (s Service) UpdateArrivalState(ctx context.Context, input UpdateArrivalStateInput) (Arrival, error) {
	if input.TenantID.IsZero() || input.ArrivalHandle.IsZero() {
		return Arrival{}, ErrArrivalNotFound
	}
	if !input.State.valid() {
		return Arrival{}, ErrArrivalUnavailable
	}
	if len(input.Reason) > MaxDisplayNameBytes || !isASCII(input.Reason) {
		return Arrival{}, ErrInvalidArrival
	}
	if input.ParticipantGeneration < 0 {
		return Arrival{}, ErrInvalidArrival
	}
	accessState := input.State == ArrivalAdmitted || input.State == ArrivalLeft
	if accessState && (input.EpisodeID.IsZero() || input.ParticipantID.IsZero() || input.ParticipantGeneration == 0) {
		return Arrival{}, ErrInvalidArrival
	}
	if err := validateProviderBinding(input.Provider, input.ProviderSubject, accessState); err != nil {
		return Arrival{}, err
	}
	return s.repository.UpdateArrivalState(ctx, input)
}
