package publicinviteapp

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestLifecycleActionsEndsExactLiveEpisodeWithStableRequestKey(t *testing.T) {
	tenantID := lifecycleActionTestID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := lifecycleActionTestID(t, "22222222-2222-4222-8222-222222222222")
	arrivalID := lifecycleActionTestID(t, "33333333-3333-4333-8333-333333333333")
	endedID := lifecycleActionTestID(t, "44444444-4444-4444-8444-444444444444")
	activeID := lifecycleActionTestID(t, "55555555-5555-4555-8555-555555555555")
	requestKey := "public-space-lifecycle-v1-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222-end"

	episodeService := &lifecycleActionEpisodesFake{episodes: []episodes.Episode{
		{ID: endedID, TenantID: tenantID, SpaceID: spaceID, Status: episodes.EpisodeStatusEnded},
		{ID: activeID, TenantID: tenantID, SpaceID: spaceID, Status: episodes.EpisodeStatusActive},
	}}
	actions, err := NewLifecycleActions(episodeService, &lifecycleActionSpacesFake{})
	if err != nil {
		t.Fatalf("new lifecycle actions: %v", err)
	}

	err = actions.EndEpisode(context.Background(), publicinvites.LifecycleActionInput{
		TenantID: tenantID, SpaceID: spaceID, CreatorArrivalHandle: arrivalID, RequestKey: requestKey,
	})
	if err != nil {
		t.Fatalf("end Episode: %v", err)
	}
	if episodeService.endInput.EpisodeID != activeID {
		t.Fatalf("ended Episode = %s, want %s", episodeService.endInput.EpisodeID, activeID)
	}
	if episodeService.endInput.Request.Key != requestKey {
		t.Fatalf("request key = %q, want %q", episodeService.endInput.Request.Key, requestKey)
	}
}

func TestLifecycleActionsArchiveUsesExactIDsAndValidatesStableRequestKey(t *testing.T) {
	tenantID := lifecycleActionTestID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := lifecycleActionTestID(t, "22222222-2222-4222-8222-222222222222")
	arrivalID := lifecycleActionTestID(t, "33333333-3333-4333-8333-333333333333")
	spacesService := &lifecycleActionSpacesFake{}
	actions, err := NewLifecycleActions(&lifecycleActionEpisodesFake{}, spacesService)
	if err != nil {
		t.Fatalf("new lifecycle actions: %v", err)
	}
	input := publicinvites.LifecycleActionInput{
		TenantID: tenantID, SpaceID: spaceID, CreatorArrivalHandle: arrivalID,
		RequestKey: "public-space-lifecycle-v1-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222-archive",
	}
	if err := actions.ArchiveSpace(context.Background(), input); err != nil {
		t.Fatalf("archive Space: %v", err)
	}
	if spacesService.tenantID != tenantID || spacesService.spaceID != spaceID {
		t.Fatalf("archived IDs = %s/%s, want %s/%s", spacesService.tenantID, spacesService.spaceID, tenantID, spaceID)
	}

	input.RequestKey = "bad"
	if err := actions.ArchiveSpace(context.Background(), input); !errors.Is(err, publicinvites.ErrInvalidRequestKey) {
		t.Fatalf("invalid request key error = %v, want %v", err, publicinvites.ErrInvalidRequestKey)
	}
}

func TestLifecycleActionsSkipsWhenNoLiveEpisodeExists(t *testing.T) {
	tenantID := lifecycleActionTestID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := lifecycleActionTestID(t, "22222222-2222-4222-8222-222222222222")
	arrivalID := lifecycleActionTestID(t, "33333333-3333-4333-8333-333333333333")
	episodeService := &lifecycleActionEpisodesFake{episodes: []episodes.Episode{{TenantID: tenantID, SpaceID: spaceID, Status: episodes.EpisodeStatusEnded}}}
	actions, err := NewLifecycleActions(episodeService, &lifecycleActionSpacesFake{})
	if err != nil {
		t.Fatalf("new lifecycle actions: %v", err)
	}

	err = actions.EndEpisode(context.Background(), publicinvites.LifecycleActionInput{
		TenantID: tenantID, SpaceID: spaceID, CreatorArrivalHandle: arrivalID,
		RequestKey: "public-space-lifecycle-v1-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222-end",
	})
	if err != nil {
		t.Fatalf("end Episode without live Episode: %v", err)
	}
	if !episodeService.endInput.EpisodeID.IsZero() {
		t.Fatalf("unexpected end request for Episode %s", episodeService.endInput.EpisodeID)
	}
}

func lifecycleActionTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test ID %q: %v", value, err)
	}
	return id
}

type lifecycleActionEpisodesFake struct {
	episodes  []episodes.Episode
	endInput  episodes.RequestEpisodeEndInput
	listError error
}

func (f *lifecycleActionEpisodesFake) ListEpisodes(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (episodes.EpisodeList, error) {
	if f.listError != nil {
		return episodes.EpisodeList{}, f.listError
	}
	return episodes.EpisodeList{Episodes: f.episodes}, nil
}

func (f *lifecycleActionEpisodesFake) RequestEpisodeEnd(_ context.Context, input episodes.RequestEpisodeEndInput) (episodes.EndRequest, error) {
	f.endInput = input
	return episodes.EndRequest{}, nil
}

type lifecycleActionSpacesFake struct {
	tenantID utilities.ID
	spaceID  utilities.ID
}

func (f *lifecycleActionSpacesFake) ArchiveSpace(_ context.Context, tenantID, spaceID utilities.ID) (spaces.Space, error) {
	f.tenantID = tenantID
	f.spaceID = spaceID
	return spaces.Space{TenantID: tenantID, ID: spaceID}, nil
}
