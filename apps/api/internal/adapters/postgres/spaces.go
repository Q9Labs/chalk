package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type SpaceRepository struct {
	queries spaceQuerier
	pool    *pgxpool.Pool
}

type spaceQuerier interface {
	CreateSpace(ctx context.Context, arg sqlc.CreateSpaceParams) (sqlc.CreateSpaceRow, error)
	ListSpaceRoles(ctx context.Context, arg sqlc.ListSpaceRolesParams) ([]sqlc.SpaceRole, error)
	GetTenantSpace(ctx context.Context, arg sqlc.GetTenantSpaceParams) (sqlc.Space, error)
	ListTenantSpaces(ctx context.Context, arg sqlc.ListTenantSpacesParams) ([]sqlc.Space, error)
	UpdateTenantSpace(ctx context.Context, arg sqlc.UpdateTenantSpaceParams) (sqlc.Space, error)
	ArchiveTenantSpace(ctx context.Context, arg sqlc.ArchiveTenantSpaceParams) (sqlc.Space, error)
	RestoreTenantSpace(ctx context.Context, arg sqlc.RestoreTenantSpaceParams) (sqlc.Space, error)
	AdoptSpaceMediaPlaneSetting(ctx context.Context, arg sqlc.AdoptSpaceMediaPlaneSettingParams) (int64, error)
}

func NewSpaceRepository(queries spaceQuerier, pools ...*pgxpool.Pool) SpaceRepository {
	var pool *pgxpool.Pool
	if len(pools) > 0 {
		pool = pools[0]
	}
	return SpaceRepository{queries: queries, pool: pool}
}

func (r SpaceRepository) CreateSpace(ctx context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	if r.pool != nil {
		return r.createSpaceWithWebhook(ctx, input)
	}

	space, err := r.queries.CreateSpace(ctx, createSpaceParams(input))
	if err != nil {
		if uniqueConstraintViolation(err, "spaces_tenant_id_slug_key") {
			return spaces.Space{}, spaces.ErrSpaceSlugAlreadyUsed
		}
		return spaces.Space{}, fmt.Errorf("create space: %w", err)
	}

	return r.withSpaceRoles(ctx, mapCreatedSpace(space))
}

// CreateSpaceIdempotent persists the request reservation and Space in the
// same transaction. Replays return the original resource metadata and never
// emit a second space.created webhook.
func (r SpaceRepository) CreateSpaceIdempotent(ctx context.Context, input spaces.CreateSpaceInput) (spaces.Space, error) {
	if r.pool == nil {
		return spaces.Space{}, errors.New("space idempotency requires a postgres pool")
	}
	return r.createSpaceWithWebhook(ctx, input)
}

func (r SpaceRepository) GetSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (spaces.Space, error) {
	space, err := r.queries.GetTenantSpace(ctx, sqlc.GetTenantSpaceParams{TenantID: uuid(tenantID), ID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		return spaces.Space{}, fmt.Errorf("get space: %w", err)
	}

	return r.withSpaceRoles(ctx, mapSpace(space))
}

func (r SpaceRepository) ListSpaces(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (spaces.SpaceList, error) {
	return r.listSpaces(ctx, tenantID, page, nil)
}

func (r SpaceRepository) ListSpacesFiltered(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest, archived *bool) (spaces.SpaceList, error) {
	return r.listSpaces(ctx, tenantID, page, archived)
}

func (r SpaceRepository) listSpaces(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest, archived *bool) (spaces.SpaceList, error) {
	rows, err := r.queries.ListTenantSpaces(ctx, listTenantSpacesParams(tenantID, page, archived))
	if err != nil {
		return spaces.SpaceList{}, fmt.Errorf("list spaces: %w", err)
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	list := spaces.SpaceList{
		Spaces: make([]spaces.Space, 0, len(rows)),
		Page:   pagination.Page{PageSize: size, HasMore: hasMore},
	}
	for _, row := range rows {
		space, err := r.withSpaceRoles(ctx, mapSpace(row))
		if err != nil {
			return spaces.SpaceList{}, err
		}
		list.Spaces = append(list.Spaces, space)
	}
	if hasMore && len(list.Spaces) > 0 {
		last := list.Spaces[len(list.Spaces)-1]
		list.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}

	return list, nil
}

func (r SpaceRepository) UpdateSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, input spaces.UpdateSpaceInput) (spaces.Space, error) {
	if r.pool != nil {
		return r.updateSpaceWithWebhook(ctx, tenantID, spaceID, input)
	}

	space, err := r.queries.UpdateTenantSpace(ctx, sqlc.UpdateTenantSpaceParams{
		TenantID:                         uuid(tenantID),
		ID:                               uuid(spaceID),
		NameSet:                          input.Name.Set,
		Name:                             requiredText(input.Name),
		SlugSet:                          input.Slug.Set,
		Slug:                             requiredText(input.Slug),
		MediaPlaneSet:                    input.MediaPlane.Set,
		MediaPlane:                       requiredText(input.MediaPlane),
		MediaPlaneSettingSet:             input.MediaPlaneSetting.Set,
		MediaPlaneSetting:                optionalPlaneSetting(input.MediaPlaneSetting),
		MetadataSet:                      input.Metadata.Set,
		Metadata:                         jsonBytes(input.Metadata.Value),
		RecurringPolicySet:               input.RecurringPolicy.Set,
		RecurringPolicy:                  jsonBytes(input.RecurringPolicy.Value),
		AdmissionPolicySet:               input.AdmissionPolicy.Set,
		AdmissionPolicy:                  jsonBytes(input.AdmissionPolicy.Value),
		DefaultEpisodeDurationSecondsSet: input.DefaultEpisodeDurationSeconds.Set,
		DefaultEpisodeDurationSeconds:    optionalInt32(input.DefaultEpisodeDurationSeconds),
		MaximumEpisodeDurationSecondsSet: input.MaximumEpisodeDurationSeconds.Set,
		MaximumEpisodeDurationSeconds:    optionalInt32(input.MaximumEpisodeDurationSeconds),
		LingerWindowSecondsSet:           input.LingerWindowSeconds.Set,
		LingerWindowSeconds:              optionalInt32(input.LingerWindowSeconds),
		RecordingPolicySet:               input.RecordingPolicy.Set,
		RecordingPolicy:                  optionalRecordingPolicy(input.RecordingPolicy),
		TranscriptionPolicySet:           input.TranscriptionPolicy.Set,
		TranscriptLanguageSet:            input.TranscriptLanguage.Set,
		TranscriptLanguage:               text(optionalLanguageString(input.TranscriptLanguage.Value)),
		TranscriptionPolicy:              optionalTranscriptionPolicy(input.TranscriptionPolicy),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		if uniqueConstraintViolation(err, "spaces_tenant_id_slug_key") {
			return spaces.Space{}, spaces.ErrSpaceSlugAlreadyUsed
		}
		return spaces.Space{}, fmt.Errorf("update space: %w", err)
	}

	return r.withSpaceRoles(ctx, mapSpace(space))
}

func (r SpaceRepository) ArchiveSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (spaces.Space, error) {
	if r.pool != nil {
		return r.archiveSpaceWithWebhook(ctx, tenantID, spaceID)
	}
	space, err := r.queries.ArchiveTenantSpace(ctx, sqlc.ArchiveTenantSpaceParams{TenantID: uuid(tenantID), ID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		return spaces.Space{}, fmt.Errorf("archive space: %w", err)
	}
	return r.withSpaceRoles(ctx, mapSpace(space))
}

func (r SpaceRepository) RestoreSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (spaces.Space, error) {
	if r.pool != nil {
		return r.restoreSpaceWithWebhook(ctx, tenantID, spaceID)
	}
	space, err := r.queries.RestoreTenantSpace(ctx, sqlc.RestoreTenantSpaceParams{TenantID: uuid(tenantID), ID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return spaces.Space{}, spaces.ErrSpaceNotFound
	}
	if err != nil {
		return spaces.Space{}, fmt.Errorf("restore space: %w", err)
	}
	return r.withSpaceRoles(ctx, mapSpace(space))
}

func (r SpaceRepository) withSpaceRoles(ctx context.Context, space spaces.Space) (spaces.Space, error) {
	roles, err := r.queries.ListSpaceRoles(ctx, sqlc.ListSpaceRolesParams{TenantID: uuid(space.TenantID), SpaceID: uuid(space.ID)})
	if err != nil {
		return spaces.Space{}, fmt.Errorf("list space roles: %w", err)
	}
	space.Roles = make([]spaces.Role, 0, len(roles))
	for _, role := range roles {
		space.Roles = append(space.Roles, mapSpaceRole(role))
	}
	return space, nil
}

var _ spaces.Repository = SpaceRepository{}

// AdoptStoredPlaneSetting moves a Space stored on the plane onto the setting. It reports
// false when the Space no longer qualifies: it gained a setting, stores another plane, or
// its Tenant can no longer serve the own SFU. No Space reads differently afterwards, so it
// sends no space.updated event.
func (r SpaceRepository) AdoptStoredPlaneSetting(ctx context.Context, tenantID, spaceID utilities.ID, plane spaces.MediaPlaneProvider) (bool, error) {
	rows, err := r.queries.AdoptSpaceMediaPlaneSetting(ctx, sqlc.AdoptSpaceMediaPlaneSettingParams{
		Plane: string(plane), TenantID: uuid(tenantID), ID: uuid(spaceID),
	})
	if err != nil {
		return false, err
	}
	return rows == 1, nil
}
