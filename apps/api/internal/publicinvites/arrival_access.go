package publicinvites

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const guestCredentialDerivationContext = "chalk/public-invite/guest-credential/v1"

func (r Runtime) deriveGuestCredential(token Token, requestKey string) ([]byte, error) {
	if r.service.signer == nil {
		return nil, ErrInvalidKeyring
	}
	if len(token.Handle) != HandleBytes || token.Generation == 0 {
		return nil, ErrInvalidToken
	}
	if err := validateIdempotencyKey(requestKey); err != nil {
		return nil, err
	}
	if token.KeyID == "" {
		token.KeyID = r.service.signer.keyring.CurrentKeyID
	}
	mac := hmac.New(sha256.New, r.service.signer.keyring.Signer)
	_, _ = mac.Write([]byte(guestCredentialDerivationContext))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(token.KeyID))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write(token.Handle)
	var generation [8]byte
	binary.BigEndian.PutUint64(generation[:], token.Generation)
	_, _ = mac.Write(generation[:])
	_, _ = mac.Write([]byte(requestKey))
	return mac.Sum(nil), nil
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

func (r Runtime) authorizeAccount(ctx context.Context, accountID, tenantID utilities.ID) (bool, error) {
	if accountID.IsZero() {
		return false, nil
	}
	return r.accounts.AuthorizePublicAccount(ctx, accountID, tenantID)
}

func validateAccessGrant(grant PublicAccessGrant, arrival Arrival) error {
	if grant.TenantID != arrival.TenantID || grant.SpaceID != arrival.SpaceID || grant.EpisodeID.IsZero() || grant.ParticipantID.IsZero() || grant.ParticipantGeneration <= 0 {
		return ErrArrivalUnavailable
	}
	if err := validateProviderBinding(grant.Provider, grant.ProviderSubject, true); err != nil {
		return err
	}
	payload := grant.ClientPayload
	if grant.Provider != PublicProviderChalkSFU || !validClientPayloadField(payload.ConnectionID) || !validClientPayloadField(payload.EpisodeRef) {
		return ErrInvalidArrival
	}
	return nil
}

func validClientPayloadField(value string) bool {
	return value != "" && len(value) <= MaxClientPayloadFieldBytes && isASCII(value)
}

func decodeGuestCredential(value string) ([]byte, error) {
	if value == "" {
		return nil, nil
	}
	if decoded, err := base64.RawURLEncoding.DecodeString(value); err == nil && len(decoded) >= 16 && len(decoded) <= 256 {
		return decoded, nil
	}
	return []byte(value), nil
}
