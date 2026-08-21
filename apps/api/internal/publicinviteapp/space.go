package publicinviteapp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrSpacePortUnavailable = errors.New("public Space adapter unavailable")
	ErrInvalidSpacePort     = errors.New("invalid public Space adapter configuration")
)

// SpaceConfig contains the platform-owned defaults for an auto-created public
// Space. The managed Tenant is resolved before creation so a bad deployment
// configuration cannot create a Space in another Tenant.
type SpaceConfig struct {
	ManagedTenantID   utilities.ID
	DefaultMediaPlane string
}

type spaceService interface {
	CreateSpace(context.Context, spaces.CreateSpaceInput) (spaces.Space, error)
	GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error)
}

type tenantService interface {
	GetTenant(context.Context, utilities.ID) (tenants.Tenant, error)
}

type spacePort struct {
	spaces spaceService
	tenant tenantService
	config SpaceConfig
}

// NewSpacePort adapts the existing Space and Tenant services to the
// public-invites port. The returned value is safe to pass directly to
// publicinvites.NewRuntime.
func NewSpacePort(spaceService spaceService, tenantService tenantService, config SpaceConfig) (publicinvites.Space, error) {
	if spaceService == nil || tenantService == nil {
		return nil, ErrSpacePortUnavailable
	}
	if config.ManagedTenantID.IsZero() || strings.TrimSpace(config.DefaultMediaPlane) == "" {
		return nil, ErrInvalidSpacePort
	}
	return spacePort{spaces: spaceService, tenant: tenantService, config: SpaceConfig{
		ManagedTenantID:   config.ManagedTenantID,
		DefaultMediaPlane: strings.TrimSpace(config.DefaultMediaPlane),
	}}, nil
}

func (a spacePort) CreatePublicSpace(ctx context.Context, input publicinvites.CreatePublicSpaceInput) (publicinvites.PublicSpace, error) {
	if strings.TrimSpace(input.DisplayName) == "" {
		return publicinvites.PublicSpace{}, publicinvites.ErrInvalidArrival
	}
	if !validRequestKey(input.RequestKey) {
		return publicinvites.PublicSpace{}, publicinvites.ErrInvalidRequestKey
	}
	if _, err := a.tenant.GetTenant(ctx, a.config.ManagedTenantID); err != nil {
		return publicinvites.PublicSpace{}, fmt.Errorf("resolve managed Tenant for public Space: %w", err)
	}

	created, err := a.spaces.CreateSpace(ctx, spaces.CreateSpaceInput{
		Name:                          strings.TrimSpace(input.DisplayName),
		TenantID:                      a.config.ManagedTenantID,
		Slug:                          publicSpaceSlug(input.RequestKey),
		MediaPlane:                    a.config.DefaultMediaPlane,
		Metadata:                      json.RawMessage(`{}`),
		AdmissionPolicy:               json.RawMessage(`{"mode":"open"}`),
		DefaultEpisodeDurationSeconds: 3600,
		MaximumEpisodeDurationSeconds: 3600,
		LingerWindowSeconds:           0,
		RequestKey:                    input.RequestKey,
	})
	if err != nil {
		return publicinvites.PublicSpace{}, fmt.Errorf("create public Space: %w", err)
	}
	return mapSpace(created)
}

func (a spacePort) GetPublicSpace(ctx context.Context, tenantID, spaceID utilities.ID) (publicinvites.PublicSpace, error) {
	space, err := a.spaces.GetSpace(ctx, tenantID, spaceID)
	if err != nil {
		return publicinvites.PublicSpace{}, fmt.Errorf("read public Space: %w", err)
	}
	if space.TenantID != tenantID || space.ID != spaceID {
		return publicinvites.PublicSpace{}, publicinvites.ErrInviteUnavailable
	}
	return mapSpace(space)
}

type admissionPolicy struct {
	Mode string `json:"mode"`
}

func mapSpace(space spaces.Space) (publicinvites.PublicSpace, error) {
	policy, err := decodeAdmissionPolicy(space.AdmissionPolicy)
	if err != nil {
		return publicinvites.PublicSpace{}, err
	}
	return publicinvites.PublicSpace{
		TenantID:      space.TenantID,
		SpaceID:       space.ID,
		Name:          space.Name,
		Slug:          space.Slug,
		Archived:      space.ArchivedAt != nil,
		AdmissionMode: publicinvites.AdmissionMode(policy.Mode),
	}, nil
}

func decodeAdmissionPolicy(raw json.RawMessage) (admissionPolicy, error) {
	if len(raw) == 0 {
		return admissionPolicy{}, publicinvites.ErrInvalidInvite
	}
	var policy admissionPolicy
	if err := json.Unmarshal(raw, &policy); err != nil {
		return admissionPolicy{}, publicinvites.ErrInvalidInvite
	}
	switch publicinvites.AdmissionMode(policy.Mode) {
	case publicinvites.AdmissionOpen, publicinvites.AdmissionKnock, publicinvites.AdmissionMembersOnly:
		return policy, nil
	default:
		return admissionPolicy{}, publicinvites.ErrInvalidInvite
	}
}

func publicSpaceSlug(requestKey string) string {
	digest := sha256.Sum256([]byte(requestKey))
	return "public-" + hex.EncodeToString(digest[:16])
}

func validRequestKey(value string) bool {
	if len(value) < publicinvites.MinIdempotencyKeyBytes || len(value) > publicinvites.MaxIdempotencyKeyBytes {
		return false
	}
	for _, character := range value {
		if (character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') && character != '_' && character != '-' {
			return false
		}
	}
	return true
}

var _ publicinvites.Space = spacePort{}
