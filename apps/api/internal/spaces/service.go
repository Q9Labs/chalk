package spaces

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type Service struct {
	repository Repository
	newSpace   NewSpaceDefaults
	tenants    TenantReader
	killSwitch NewEpisodeSwitch
	planes     PlanePolicy
}

func NewServiceWithDefaultProvider(repository Repository, defaultProvider MediaPlaneProvider) Service {
	return Service{repository: repository, planes: PlanePolicy{Platform: defaultProvider}}
}

// WithPlanePolicy sets the deployment's plane policy: the platform default that new
// Spaces inherit, and the own-SFU kill switch and allowlist that Effective applies.
func (s Service) WithPlanePolicy(policy PlanePolicy) Service {
	s.planes = policy
	return s
}

// WithNewEpisodeSwitch lets the effective plane follow the live kill switch.
func (s Service) WithNewEpisodeSwitch(killSwitch NewEpisodeSwitch) Service {
	s.killSwitch = killSwitch
	return s
}

// WithNewSpaceDefaults sets what a Create Space request gets for the fields it
// omits. It changes new Spaces only: Spaces and Tenants that store no plane keep
// resolving to the deployment default. The Tenant reader decides per Tenant
// whether the new-Space plane applies.
func (s Service) WithNewSpaceDefaults(defaults NewSpaceDefaults, tenants TenantReader) Service {
	s.newSpace = defaults
	s.tenants = tenants
	return s
}

// planeForNewSpace returns the plane for a Space whose request names none, and
// whether it is the configured new-Space plane. A Tenant that pins its own
// provider keeps the deployment default.
func (s Service) planeForNewSpace(ctx context.Context, tenantID utilities.ID) (plane MediaPlaneProvider, newSpacePlane bool, err error) {
	if s.newSpace.MediaPlane != "" {
		tenant, err := s.tenants.GetTenant(ctx, tenantID)
		if err != nil {
			return "", false, fmt.Errorf("read Tenant for the new Space plane: %w", err)
		}
		if tenantServesNewSpacePlane(tenant) {
			return s.newSpace.MediaPlane, true, nil
		}
	}
	return s.planes.Platform, false, nil
}

// tenantModeChalkManaged is mediaplaneproviders.ModeChalkManaged, which this
// package cannot import because that package imports this one.
const tenantModeChalkManaged = "chalk_managed"

// tenantServesNewSpacePlane is true when Chalk runs every provider for the Tenant
// and the Tenant names no plane of its own. A Tenant default plane is its own choice.
func tenantServesNewSpacePlane(tenant tenants.Tenant) bool {
	return tenantDefault(tenant) == nil && tenantRunsEveryProvider(tenant)
}

func (s Service) CreateSpace(ctx context.Context, input CreateSpaceInput) (Space, error) {
	id, err := utilities.NewID()
	if err != nil {
		return Space{}, err
	}
	input.ID = id
	input.MediaPlaneSetting = nil
	explicitPlane := input.MediaPlaneSet || input.MediaPlane != ""
	newSpacePlane, err := s.applyNewSpaceDefaults(ctx, &input, explicitPlane)
	if err != nil {
		return Space{}, err
	}
	if _, err := rand.Read(input.PublicInviteHandle[:]); err != nil {
		return Space{}, err
	}
	if err := prepareCreateSpaceInput(&input); err != nil {
		return Space{}, err
	}
	if err := s.bindMediaPlane(&input, explicitPlane, newSpacePlane); err != nil {
		return Space{}, err
	}
	if input.RequestKey == "" {
		return s.repository.CreateSpace(ctx, input)
	}
	return s.createIdempotent(ctx, input)
}

// applyNewSpaceDefaults picks the plane and artifact policies of a Space whose
// request names no plane. It reports whether the plane is the configured new-Space plane.
func (s Service) applyNewSpaceDefaults(ctx context.Context, input *CreateSpaceInput, explicitPlane bool) (bool, error) {
	if explicitPlane {
		return false, nil
	}
	plane, newSpacePlane, err := s.planeForNewSpace(ctx, input.TenantID)
	if err != nil {
		return false, err
	}
	input.MediaPlane = string(plane)
	if newSpacePlane && !input.RecordingPolicySet && s.newSpace.RecordingPolicy != "" {
		input.RecordingPolicy, input.RecordingPolicySet = s.newSpace.RecordingPolicy, true
	}
	if newSpacePlane && !input.TranscriptionPolicySet && s.newSpace.TranscriptionPolicy != "" {
		input.TranscriptionPolicy, input.TranscriptionPolicySet = s.newSpace.TranscriptionPolicy, true
	}
	return newSpacePlane, nil
}

// bindMediaPlane records the plane only when the Space owns the choice. The request
// names a plane only when the caller may; a Space that names none inherits, except
// that the configured new-Space plane is the Space's own choice.
func (s Service) bindMediaPlane(input *CreateSpaceInput, explicitPlane, newSpacePlane bool) error {
	provider := MediaPlaneProvider(input.MediaPlane)
	switch {
	case explicitPlane && !input.MediaPlaneFromConfig:
		if err := s.planes.publicWriteAllowed(provider); err != nil {
			return err
		}
		if provider == MediaPlaneProviderChalkSFU {
			// A public write naming the own SFU inherits; see PublicWriteAllowed.
			input.MediaPlane = s.planes.legacyPlane(nil)
			return nil
		}
		input.MediaPlaneSetting = &provider
	case explicitPlane || newSpacePlane:
		input.MediaPlaneSetting = &provider
	default:
		input.MediaPlane = s.planes.legacyPlane(nil)
	}
	return nil
}

func (s Service) createIdempotent(ctx context.Context, input CreateSpaceInput) (Space, error) {
	if !spaceRequestKeyPattern.MatchString(input.RequestKey) {
		return Space{}, ErrInvalidRequestKey
	}
	fingerprint, err := createFingerprint(input)
	if err != nil {
		return Space{}, err
	}
	input.RequestFingerprint = fingerprint
	idempotent, ok := s.repository.(IdempotentRepository)
	if !ok {
		return Space{}, errors.New("space idempotency repository unavailable")
	}
	return idempotent.CreateSpaceIdempotent(ctx, input)
}

func (s Service) GetSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (Space, error) {
	if err := validateTenantSpaceIDs(tenantID, spaceID); err != nil {
		return Space{}, err
	}

	return s.repository.GetSpace(ctx, tenantID, spaceID)
}

func (s Service) ListSpaces(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (SpaceList, error) {
	if tenantID.IsZero() {
		return SpaceList{}, ErrInvalidTenantID
	}

	return s.repository.ListSpaces(ctx, tenantID, page)
}

func (s Service) ListSpacesFiltered(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest, archived *bool) (SpaceList, error) {
	if tenantID.IsZero() {
		return SpaceList{}, ErrInvalidTenantID
	}
	filtered, ok := s.repository.(FilteredRepository)
	if !ok || archived == nil {
		return s.repository.ListSpaces(ctx, tenantID, page)
	}
	return filtered.ListSpacesFiltered(ctx, tenantID, page, archived)
}

func (s Service) UpdateSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, input UpdateSpaceInput) (Space, error) {
	if err := validateTenantSpaceIDs(tenantID, spaceID); err != nil {
		return Space{}, err
	}
	if err := prepareUpdateSpaceInput(&input); err != nil {
		return Space{}, err
	}
	input.MediaPlaneSetting = OptionalMediaPlaneSetting{}
	if input.MediaPlane.Set {
		var setting *MediaPlaneProvider
		if input.MediaPlane.Value != nil {
			provider := MediaPlaneProvider(*input.MediaPlane.Value)
			if err := s.planes.publicWriteAllowed(provider); err != nil {
				return Space{}, err
			}
			if provider != MediaPlaneProviderChalkSFU { // naming the own SFU inherits; see PublicWriteAllowed
				setting = &provider
			}
		}
		stored := s.planes.legacyPlane(setting)
		if stored == "" {
			// Clearing with no platform default: the column is not null, and Cloudflare is what a
			// public write may name anyway.
			stored = string(s.planes.PublicWritePlane())
		}
		input.MediaPlaneSetting = OptionalMediaPlaneSetting{Set: true, Value: setting}
		input.MediaPlane.Value = &stored
	}

	return s.repository.UpdateSpace(ctx, tenantID, spaceID, input)
}

func (s Service) ArchiveSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (Space, error) {
	if err := validateTenantSpaceIDs(tenantID, spaceID); err != nil {
		return Space{}, err
	}
	repository, ok := s.repository.(ArchiveRepository)
	if !ok {
		return Space{}, ErrSpaceNotFound
	}
	return repository.ArchiveSpace(ctx, tenantID, spaceID)
}

func (s Service) RestoreSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (Space, error) {
	if err := validateTenantSpaceIDs(tenantID, spaceID); err != nil {
		return Space{}, err
	}
	repository, ok := s.repository.(ArchiveRepository)
	if !ok {
		return Space{}, ErrSpaceNotFound
	}
	return repository.RestoreSpace(ctx, tenantID, spaceID)
}
