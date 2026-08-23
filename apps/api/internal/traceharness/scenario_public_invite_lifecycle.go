package traceharness

import (
	"context"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func runServicePublicInviteLifecycle(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	lifecycle := &tracedPublicInviteLifecycle{
		recorder: recorder,
		due: publicinvites.AutoLifecycle{
			TenantID:             tenantID(),
			SpaceID:              spaceID(),
			DeadlineAt:           now().Add(time.Hour),
			CreatorArrivalHandle: mustID("33333333-3333-4333-8333-333333333333"),
			State:                publicinvites.AutoLifecycleActive,
		},
		activeParticipants: true,
	}
	actions := &tracedPublicInviteLifecycleActions{recorder: recorder}
	worker, err := publicinvites.NewLifecycleWorkerWithBatch(lifecycle, actions, 1)
	if err != nil {
		return directResult(ServicePublicInviteLifecycleScenario, http.StatusInternalServerError, recorder, nil, err)
	}

	waiting, err := worker.Run(ctx)
	if err != nil {
		return directResult(ServicePublicInviteLifecycleScenario, http.StatusInternalServerError, recorder, nil, err)
	}
	lifecycle.activeParticipants = false
	archived, err := worker.Run(ctx)
	if err != nil {
		return directResult(ServicePublicInviteLifecycleScenario, http.StatusInternalServerError, recorder, nil, err)
	}

	return directResult(ServicePublicInviteLifecycleScenario, http.StatusOK, recorder, map[string]any{
		"active_participants_waited": waiting.Listed == 0 && waiting.Archived == 0,
		"final_participant_archived": archived.Archived == 1 && len(actions.events) == 2,
		"end_episode_before_archive": actions.events,
	}, nil)
}

type tracedPublicInviteLifecycle struct {
	recorder           *Recorder
	due                publicinvites.AutoLifecycle
	activeParticipants bool
}

func (l *tracedPublicInviteLifecycle) CreateAutoLifecycle(context.Context, publicinvites.AutoLifecycle) (publicinvites.AutoLifecycle, error) {
	return l.due, nil
}

func (l *tracedPublicInviteLifecycle) GetAutoLifecycle(context.Context, utilities.ID, utilities.ID) (publicinvites.AutoLifecycle, error) {
	return l.due, nil
}

func (l *tracedPublicInviteLifecycle) ListDueAutoLifecycles(_ context.Context, _ time.Time, _ int32) ([]publicinvites.AutoLifecycle, error) {
	span := l.recorder.Start("repository", "PublicInviteRepository.ListDueAutoLifecycles", "list lifecycle rows whose creator has left and whose Episode has no live Participants", map[string]any{
		"creator_arrival_state": "left",
		"active_participants":   l.activeParticipants,
	})
	if l.due.State != publicinvites.AutoLifecycleActive {
		span.End("ignore the lifecycle after it is archived", map[string]any{
			"due": false,
		}, nil)
		return nil, nil
	}
	if l.activeParticipants {
		span.End("keep the lifecycle active while another Participant remains", map[string]any{
			"due": false,
		}, nil)
		return nil, nil
	}
	span.End("return the lifecycle after the final Participant leaves", map[string]any{
		"due": true,
	}, nil)
	return []publicinvites.AutoLifecycle{l.due}, nil
}

func (l *tracedPublicInviteLifecycle) MarkAutoLifecycleArchiving(_ context.Context, tenantID, spaceID utilities.ID) (publicinvites.AutoLifecycle, error) {
	l.recorder.Add("repository", "PublicInviteRepository.MarkAutoLifecycleArchiving", "claim the due lifecycle before external Episode and Space actions", map[string]any{
		"tenant_id": tenantID.String(),
		"space_id":  spaceID.String(),
	})
	l.due.State = publicinvites.AutoLifecycleArchiving
	return l.due, nil
}

func (l *tracedPublicInviteLifecycle) MarkAutoLifecycleArchived(context.Context, utilities.ID, utilities.ID) (publicinvites.AutoLifecycle, error) {
	l.due.State = publicinvites.AutoLifecycleArchived
	l.recorder.Add("repository", "PublicInviteRepository.MarkAutoLifecycleArchived", "record the completed lifecycle after both external actions succeed", map[string]any{
		"state": string(l.due.State),
	})
	return l.due, nil
}

func (l *tracedPublicInviteLifecycle) RetryAutoLifecycle(context.Context, publicinvites.RetryAutoLifecycleInput) (publicinvites.AutoLifecycle, error) {
	return l.due, nil
}

type tracedPublicInviteLifecycleActions struct {
	recorder *Recorder
	events   []string
}

func (a *tracedPublicInviteLifecycleActions) EndEpisode(_ context.Context, input publicinvites.LifecycleActionInput) error {
	a.events = append(a.events, "end_episode")
	a.recorder.Add("adapter", "EpisodeLifecycle.EndEpisode", "end the live Episode after the final Participant leaves", map[string]any{
		"tenant_id": input.TenantID.String(),
		"space_id":  input.SpaceID.String(),
	})
	return nil
}

func (a *tracedPublicInviteLifecycleActions) ArchiveSpace(_ context.Context, input publicinvites.LifecycleActionInput) error {
	a.events = append(a.events, "archive_space")
	a.recorder.Add("adapter", "SpaceLifecycle.ArchiveSpace", "archive the public Space after its Episode ends", map[string]any{
		"tenant_id": input.TenantID.String(),
		"space_id":  input.SpaceID.String(),
	})
	return nil
}
