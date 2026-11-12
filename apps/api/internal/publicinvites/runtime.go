package publicinvites

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Runtime composes persistence with Space, lifecycle, and access ports. All
// ports are required at construction so request handlers never discover a
// missing dependency after accepting a request.
type Runtime struct {
	service               Service
	space                 Space
	lifecycle             Lifecycle
	access                Access
	accounts              Accounts
	links                 Links
	autoLifecycleLifetime time.Duration
}

func NewRuntime(service Service, space Space, lifecycle Lifecycle, access Access, accounts Accounts, links Links) (Runtime, error) {
	return NewRuntimeWithConfig(service, space, lifecycle, access, accounts, links, RuntimeConfig{AutoLifecycleLifetime: DefaultAutoLifecycleLifetime})
}

type RuntimeConfig struct {
	AutoLifecycleLifetime time.Duration
}

func NewRuntimeWithConfig(service Service, space Space, lifecycle Lifecycle, access Access, accounts Accounts, links Links, config RuntimeConfig) (Runtime, error) {
	if space == nil {
		return Runtime{}, ErrSpaceUnavailable
	}
	if lifecycle == nil {
		return Runtime{}, ErrLifecycleUnavailable
	}
	if access == nil {
		return Runtime{}, ErrAccessUnavailable
	}
	if accounts == nil {
		return Runtime{}, ErrAccountsUnavailable
	}
	if links == nil {
		return Runtime{}, ErrLinksUnavailable
	}
	if config.AutoLifecycleLifetime <= 0 || config.AutoLifecycleLifetime > DefaultAutoLifecycleLifetime {
		return Runtime{}, ErrInvalidLifecycleState
	}
	service.lifecycle = lifecycle
	return Runtime{service: service, space: space, lifecycle: lifecycle, access: access, accounts: accounts, links: links, autoLifecycleLifetime: config.AutoLifecycleLifetime}, nil
}

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

func (r Runtime) authorizeAccount(ctx context.Context, accountID, tenantID utilities.ID) (bool, error) {
	if accountID.IsZero() {
		return false, nil
	}
	return r.accounts.AuthorizePublicAccount(ctx, accountID, tenantID)
}
