package publicinvites

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type archiveRaceLifecycle struct{ Lifecycle }

func (archiveRaceLifecycle) MarkAutoLifecycleArchiving(_ context.Context, tenantID, spaceID utilities.ID) (AutoLifecycle, error) {
	return AutoLifecycle{TenantID: tenantID, SpaceID: spaceID}, nil
}

func (archiveRaceLifecycle) MarkAutoLifecycleArchived(context.Context, utilities.ID, utilities.ID) (AutoLifecycle, error) {
	return AutoLifecycle{}, nil
}

// archiveRaceActions models one Space: a guest starts an Episode between the worker's
// first EndEpisode and ArchiveSpace, and an archived Space takes no new guest.
type archiveRaceActions struct {
	archived      bool
	episodeActive bool
	ends          int
}

func (a *archiveRaceActions) EndEpisode(context.Context, LifecycleActionInput) error {
	a.ends++
	a.episodeActive = false
	return nil
}

func (a *archiveRaceActions) ArchiveSpace(context.Context, LifecycleActionInput) error {
	if a.ends == 1 {
		a.episodeActive = true
	}
	a.archived = true
	return nil
}

func TestLifecycleWorkerLeavesNoActiveEpisodeInArchivedSpace(t *testing.T) {
	actions := &archiveRaceActions{}
	worker := NewLifecycleWorker(archiveRaceLifecycle{}, actions)
	lifecycle := AutoLifecycle{
		TenantID: utilities.IDFromBytes([16]byte{1}), SpaceID: utilities.IDFromBytes([16]byte{2}), DeadlineAt: time.Now(),
		CreatorArrivalHandle: utilities.IDFromBytes([16]byte{3}), State: AutoLifecycleActive,
	}
	status, _, err := worker.process(context.Background(), time.Now(), lifecycle)
	if err != nil || status != lifecycleItemArchived {
		t.Fatalf("process = %v, %v; want archived", status, err)
	}
	if !actions.archived || actions.episodeActive {
		t.Fatalf("archived = %v, Episode active = %v; want an archived Space with no active Episode", actions.archived, actions.episodeActive)
	}
}
