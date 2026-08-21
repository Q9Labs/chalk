package publicinviteapp

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrLifecycleActionsUnavailable = errors.New("public lifecycle actions unavailable")
	ErrInvalidLifecycleAction      = errors.New("invalid public lifecycle action")
)

type episodeLifecycleActions interface {
	ListEpisodes(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (episodes.EpisodeList, error)
	RequestEpisodeEnd(context.Context, episodes.RequestEpisodeEndInput) (episodes.EndRequest, error)
}

type spaceLifecycleActions interface {
	ArchiveSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error)
}

type lifecycleActions struct {
	episodes episodeLifecycleActions
	spaces   spaceLifecycleActions
}

// NewLifecycleActions adapts the existing Episode-end and Space-archive
// services to the auto-created Space cleanup worker. ArchiveSpace is
// idempotent for the exact Tenant and Space pair because its repository
// coalesces archived_at; the request key is still checked at this boundary and
// is used for the Episode external operation.
func NewLifecycleActions(episodesService episodeLifecycleActions, spacesService spaceLifecycleActions) (publicinvites.LifecycleActions, error) {
	if episodesService == nil || spacesService == nil {
		return nil, ErrLifecycleActionsUnavailable
	}
	return lifecycleActions{episodes: episodesService, spaces: spacesService}, nil
}

func (a lifecycleActions) EndEpisode(ctx context.Context, input publicinvites.LifecycleActionInput) error {
	if err := validateLifecycleActionInput(input); err != nil {
		return err
	}
	page, err := pagination.NewPageRequest(pagination.MaxPageSize, nil)
	if err != nil {
		return fmt.Errorf("create Episode lookup page: %w", err)
	}
	episodeList, err := a.episodes.ListEpisodes(ctx, input.TenantID, input.SpaceID, page)
	if err != nil {
		return fmt.Errorf("list live Episode for auto-created Space: %w", err)
	}

	for _, episode := range episodeList.Episodes {
		if episode.TenantID != input.TenantID || episode.SpaceID != input.SpaceID {
			return ErrInvalidLifecycleAction
		}
		switch episode.Status {
		case episodes.EpisodeStatusActive:
			_, err := a.episodes.RequestEpisodeEnd(ctx, episodes.RequestEpisodeEndInput{
				TenantID:  input.TenantID,
				SpaceID:   input.SpaceID,
				EpisodeID: episode.ID,
				Request:   episodes.Request{Key: input.RequestKey},
			})
			if err != nil {
				return fmt.Errorf("end live Episode %s: %w", episode.ID, err)
			}
			return nil
		case episodes.EpisodeStatusEnding:
			continue
		}
	}
	return nil
}

func (a lifecycleActions) ArchiveSpace(ctx context.Context, input publicinvites.LifecycleActionInput) error {
	if err := validateLifecycleActionInput(input); err != nil {
		return err
	}
	if _, err := a.spaces.ArchiveSpace(ctx, input.TenantID, input.SpaceID); err != nil {
		return fmt.Errorf("archive exact Space %s: %w", input.SpaceID, err)
	}
	return nil
}

func validateLifecycleActionInput(input publicinvites.LifecycleActionInput) error {
	if input.TenantID.IsZero() || input.SpaceID.IsZero() {
		return ErrInvalidLifecycleAction
	}
	if !validLifecycleRequestKey(input.RequestKey) {
		return publicinvites.ErrInvalidRequestKey
	}
	return nil
}

func validLifecycleRequestKey(value string) bool {
	if len(value) < publicinvites.MinIdempotencyKeyBytes || len(value) > publicinvites.MaxIdempotencyKeyBytes || strings.TrimSpace(value) != value {
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

var _ publicinvites.LifecycleActions = lifecycleActions{}
