package traceharness

import (
	"context"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
)

func runServiceDashboardSpaceJoin(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	repository := &tracedDashboardSpaceJoinRepository{
		tracedEpisodeLifecycleRepository: &tracedEpisodeLifecycleRepository{recorder: recorder, now: now},
		recorder:                         recorder,
		now:                              now,
	}
	observer := &tracedDashboardSpaceJoinObserver{recorder: recorder}
	service := episodes.NewService(repository).WithCommitObserver(observer)
	input := episodes.SelfJoinInput{
		TenantID:    tenantID(),
		AccountID:   userID(),
		SpaceSlug:   "  chalk-studio  ",
		DisplayName: "  Trace Reviewer  ",
		Request:     episodes.Request{Key: "dashboard-space-join-trace-0001"},
	}

	span := recorder.Start("service", "episodes.Service.JoinSelf", "join the named Space and start its first Episode", map[string]any{
		"space_slug": input.SpaceSlug,
	})
	created, err := service.JoinSelf(ctx, input)
	span.End("return the durable Episode and account Participant", dashboardSpaceJoinResultFields(created), err)
	if err != nil {
		return directResult(ServiceDashboardSpaceJoinScenario, http.StatusInternalServerError, recorder, nil, err)
	}

	input.Request.Key = "dashboard-space-join-trace-0002"
	span = recorder.Start("service", "episodes.Service.JoinSelf", "join the same named Space while its Episode is active", map[string]any{
		"space_slug": input.SpaceSlug,
	})
	reused, err := service.JoinSelf(ctx, input)
	span.End("return the existing active Episode", dashboardSpaceJoinResultFields(reused), err)
	if err != nil {
		return directResult(ServiceDashboardSpaceJoinScenario, http.StatusInternalServerError, recorder, nil, err)
	}

	body := map[string]any{
		"episode_created":          created.EpisodeCreated,
		"episode_durable":          repository.committed,
		"episode_id":               created.Episode.ID.String(),
		"observer_notifications":   observer.notifications,
		"reused_episode":           created.Episode.ID == reused.Episode.ID,
		"reused_episode_created":   reused.EpisodeCreated,
		"start_time":               created.Episode.StartedAt.UTC().Format(time.RFC3339Nano),
		"start_time_authoritative": created.Episode.StartedAt.Equal(repository.durableEpisode.StartedAt),
	}
	return directResult(ServiceDashboardSpaceJoinScenario, http.StatusOK, recorder, body, nil)
}

type tracedDashboardSpaceJoinRepository struct {
	*tracedEpisodeLifecycleRepository
	recorder       *Recorder
	now            func() time.Time
	durableEpisode episodes.Episode
	committed      bool
	joins          int
}

func (r *tracedDashboardSpaceJoinRepository) JoinSelf(_ context.Context, input episodes.SelfJoinInput) (episodes.SelfJoinResult, error) {
	span := r.recorder.Start("repository", "EpisodeLifecycleRepository.JoinSelf", "resolve the named Space and commit the account join", map[string]any{
		"space_slug":  input.SpaceSlug,
		"request_key": input.Request.Key,
	})
	r.recorder.Add("database", "SELECT spaces", "resolve the active Space by its normalized slug", map[string]any{"slug": input.SpaceSlug})
	r.joins++

	created := r.joins == 1
	if created {
		startedAt := r.now().UTC()
		r.durableEpisode = episodes.Episode{
			ID:        lifecycleEpisodeID(),
			TenantID:  input.TenantID,
			SpaceID:   spaceID(),
			Status:    episodes.EpisodeStatusActive,
			StartedAt: startedAt,
			CreatedAt: startedAt,
		}
		r.recorder.Add("database", "INSERT episodes", "persist the active Episode with its authoritative start time", map[string]any{
			"episode_id": r.durableEpisode.ID.String(),
			"started_at": startedAt.Format(time.RFC3339Nano),
		})
	} else {
		r.recorder.Add("database", "SELECT active episode", "reuse the Space's durable active Episode", map[string]any{
			"episode_id": r.durableEpisode.ID.String(),
			"started_at": r.durableEpisode.StartedAt.Format(time.RFC3339Nano),
		})
	}

	participant := episodes.Participant{
		ID:        participantID(),
		TenantID:  input.TenantID,
		SpaceID:   r.durableEpisode.SpaceID,
		EpisodeID: r.durableEpisode.ID,
		AccountID: input.AccountID,
		Role:      "collaborator",
		Status:    episodes.ParticipantStatusJoining,
	}
	r.recorder.Add("database", "UPSERT participants", "persist the account Participant as joining", map[string]any{
		"episode_id": r.durableEpisode.ID.String(),
	})
	r.recorder.Add("database", "INSERT sync_lifecycle_intents", "schedule the durable Participant join transition", map[string]any{
		"episode_id": r.durableEpisode.ID.String(),
	})
	r.recorder.Add("database", "COMMIT", "make the Episode and account Participant durable together", nil)
	r.committed = true
	result := episodes.SelfJoinResult{Episode: r.durableEpisode, Participant: participant, EpisodeCreated: created, ParticipantCreated: created}
	span.End("account join committed", dashboardSpaceJoinResultFields(result), nil)
	return result, nil
}

func (r *tracedDashboardSpaceJoinRepository) FindSelf(context.Context, episodes.SelfAccessInput) (episodes.SelfJoinResult, error) {
	return episodes.SelfJoinResult{}, nil
}

func (r *tracedDashboardSpaceJoinRepository) LeaveSelf(context.Context, episodes.SelfLeaveInput) (episodes.SelfLeaveResult, error) {
	return episodes.SelfLeaveResult{}, nil
}

type tracedDashboardSpaceJoinObserver struct {
	recorder      *Recorder
	notifications int
}

func (o *tracedDashboardSpaceJoinObserver) EpisodeCommitted(episode episodes.Episode) {
	o.notifications++
	o.recorder.Add("observer", "episodes.CommitObserver.EpisodeCommitted", "notify diagnostics after the new Episode commits", map[string]any{
		"episode_id": episode.ID.String(),
		"started_at": episode.StartedAt.UTC().Format(time.RFC3339Nano),
	})
}

func dashboardSpaceJoinResultFields(result episodes.SelfJoinResult) map[string]any {
	return map[string]any{
		"episode_created": result.EpisodeCreated,
		"episode_id":      result.Episode.ID.String(),
		"started_at":      result.Episode.StartedAt.UTC().Format(time.RFC3339Nano),
	}
}

var _ episodes.Repository = (*tracedDashboardSpaceJoinRepository)(nil)
var _ episodes.SelfJoinRepository = (*tracedDashboardSpaceJoinRepository)(nil)
var _ episodes.CommitObserver = (*tracedDashboardSpaceJoinObserver)(nil)
