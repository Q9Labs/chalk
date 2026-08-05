package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func runRouteEpisodeCreateMember(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	service := newTracedEpisodeLifecycleService(recorder, now)
	return runEpisodeRoute(ctx, recorder, service, routeTraceConfig{
		Name: RouteEpisodeCreateMemberScenario, Method: http.MethodPost,
		Path: "/v1/tenants/" + tenantID().String() + "/spaces/" + spaceID().String() + "/episodes",
		Body: json.RawMessage(`{"metadata":{"purpose":"sync-trace"}}`), Authorization: "Bearer trace-session-token",
		Headers: map[string]string{"Idempotency-Key": "episode-create-trace-0001"}, ExpectedStatus: http.StatusCreated,
	})
}

func runRouteEpisodeAdmitMember(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	service := newTracedEpisodeLifecycleService(recorder, now)
	return runEpisodeRoute(ctx, recorder, service, routeTraceConfig{
		Name: RouteEpisodeAdmitMemberScenario, Method: http.MethodPost,
		Path: "/v1/tenants/" + tenantID().String() + "/spaces/" + spaceID().String() + "/episodes/" + lifecycleEpisodeID().String() + "/participants",
		Body: json.RawMessage(`{"participant_id":"44444444-4444-4444-8444-444444444444","name":"Ada","role":"collaborator"}`), Authorization: "Bearer trace-session-token",
		Headers: map[string]string{"Idempotency-Key": "episode-admit-trace-0001"}, ExpectedStatus: http.StatusCreated,
	})
}

func runRouteEpisodeRemoveParticipant(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	service := newTracedEpisodeLifecycleService(recorder, now)
	return runEpisodeRoute(ctx, recorder, service, routeTraceConfig{
		Name: RouteEpisodeRemoveParticipantScenario, Method: http.MethodPost,
		Path: "/v1/tenants/" + tenantID().String() + "/spaces/" + spaceID().String() + "/episodes/" + lifecycleEpisodeID().String() + "/participants/" + participantID().String() + "/remove",
		Body: json.RawMessage(`{"participant_generation":1}`), Authorization: "Bearer trace-session-token",
		Headers: map[string]string{"Idempotency-Key": "episode-remove-trace-0001"}, ExpectedStatus: http.StatusAccepted,
	})
}

func runRouteEpisodeEnd(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	service := newTracedEpisodeLifecycleService(recorder, now)
	return runEpisodeRoute(ctx, recorder, service, routeTraceConfig{
		Name: RouteEpisodeEndScenario, Method: http.MethodPost,
		Path:          "/v1/tenants/" + tenantID().String() + "/spaces/" + spaceID().String() + "/episodes/" + lifecycleEpisodeID().String() + "/end",
		Authorization: "Bearer trace-session-token", Headers: map[string]string{"Idempotency-Key": "episode-end-trace-0001"}, ExpectedStatus: http.StatusAccepted,
	})
}

func runRouteEpisodeDeadline(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	service := newTracedEpisodeLifecycleService(recorder, now)
	deadline := now().Add(10 * time.Minute).UTC().Format(time.RFC3339)
	return runEpisodeRoute(ctx, recorder, service, routeTraceConfig{
		Name: RouteEpisodeDeadlineScenario, Method: http.MethodPost,
		Path: "/v1/tenants/" + tenantID().String() + "/spaces/" + spaceID().String() + "/episodes/" + lifecycleEpisodeID().String() + "/deadline",
		Body: json.RawMessage(`{"deadline_at":"` + deadline + `"}`), Authorization: "Bearer trace-session-token",
		Headers: map[string]string{"Idempotency-Key": "episode-deadline-trace-0001"}, ExpectedStatus: http.StatusAccepted,
	})
}

func runEpisodeRoute(ctx context.Context, recorder *Recorder, service httpapi.EpisodeLifecycleService, config routeTraceConfig) (ScenarioResult, error) {
	config.Recorder = recorder
	config.Handler = httpapi.NewRouter(httpapi.Options{
		RateLimit:      noRateLimits(deterministicClock()),
		Authentication: staticAuthentication{recorder: recorder, now: deterministicClock(), principal: userPrincipal(), sessionUser: sessionUserFixture(deterministicClock())},
		TenantAuthz:    authorization.NewTenantPolicy(tracedMembershipRepository{recorder: recorder, now: deterministicClock(), policyRole: memberships.RoleCollaborator}),
		Episodes:       service,
	})
	return runRouteTrace(ctx, config)
}

type tracedEpisodeLifecycleService struct {
	recorder   *Recorder
	repository *tracedEpisodeLifecycleRepository
	next       episodes.Service
}

func newTracedEpisodeLifecycleService(recorder *Recorder, now func() time.Time) tracedEpisodeLifecycleService {
	repository := &tracedEpisodeLifecycleRepository{recorder: recorder, now: now}
	return tracedEpisodeLifecycleService{recorder: recorder, repository: repository, next: episodes.NewService(repository)}
}

func (s tracedEpisodeLifecycleService) CreateEpisode(ctx context.Context, input episodes.CreateEpisodeInput) (episodes.Episode, error) {
	span := s.recorder.Start("service", "episodes.Service.CreateEpisode", "validate the Episode request and derive its fingerprint", map[string]any{"tenant_id": input.TenantID.String(), "space_id": input.SpaceID.String(), "request_key": input.Request.Key})
	result, err := s.next.CreateEpisode(ctx, input)
	span.End("return the idempotently created Episode", map[string]any{"episode_id": result.ID.String(), "status": result.Status}, err)
	return result, err
}

func (s tracedEpisodeLifecycleService) GetEpisode(ctx context.Context, tenantID, spaceID, episodeID utilities.ID) (episodes.Episode, error) {
	return s.next.GetEpisode(ctx, tenantID, spaceID, episodeID)
}

func (s tracedEpisodeLifecycleService) ListEpisodes(ctx context.Context, tenantID, spaceID utilities.ID, page pagination.PageRequest) (episodes.EpisodeList, error) {
	return s.next.ListEpisodes(ctx, tenantID, spaceID, page)
}

func (s tracedEpisodeLifecycleService) AdmitParticipant(ctx context.Context, input episodes.AdmitParticipantInput) (episodes.Admission, error) {
	return s.next.AdmitParticipant(ctx, input)
}

func (s tracedEpisodeLifecycleService) RequestParticipantRemoval(ctx context.Context, input episodes.RequestParticipantRemovalInput) (episodes.Removal, error) {
	return s.next.RequestParticipantRemoval(ctx, input)
}

func (s tracedEpisodeLifecycleService) RequestEpisodeEnd(ctx context.Context, input episodes.RequestEpisodeEndInput) (episodes.EndRequest, error) {
	span := s.recorder.Start("service", "episodes.Service.RequestEpisodeEnd", "validate the Episode end request", map[string]any{"episode_id": input.EpisodeID.String(), "request_key": input.Request.Key})
	result, err := s.next.RequestEpisodeEnd(ctx, input)
	span.End("return the committed lifecycle intent", map[string]any{"status": result.Episode.Status, "intent_id": result.Intent.ID.String()}, err)
	return result, err
}

func (s tracedEpisodeLifecycleService) SetDeadline(ctx context.Context, input episodes.SetDeadlineInput) (episodes.ControlRequest, error) {
	return s.next.SetDeadline(ctx, input)
}

type tracedEpisodeLifecycleRepository struct {
	recorder *Recorder
	now      func() time.Time
}

func (r *tracedEpisodeLifecycleRepository) CreateEpisode(_ context.Context, input episodes.CreateEpisodeInput) (episodes.Episode, error) {
	span := r.recorder.Start("repository", "EpisodeLifecycleRepository.CreateEpisode", "run the bounded synchronous Episode transaction", map[string]any{"request_key": input.Request.Key, "episode_id": input.ID.String()})
	r.recorder.Add("database", "INSERT episode_create_requests", "reserve the durable create idempotency key", nil)
	r.recorder.Add("database", "INSERT episodes", "create the active Episode with its immutable policy snapshot", map[string]any{"status": episodes.EpisodeStatusActive})
	r.recorder.Add("database", "INSERT sync_episode_control", "create the revision-zero control row", map[string]any{"control_revision": 0})
	r.recorder.Add("database", "COMMIT", "make the Episode and control state visible atomically", nil)
	result := episodes.Episode{ID: input.ID, TenantID: input.TenantID, SpaceID: input.SpaceID, Status: episodes.EpisodeStatusActive, CreatedAt: r.now(), StartedAt: r.now()}
	span.End("transaction committed", map[string]any{"episode_id": result.ID.String(), "status": result.Status}, nil)
	return result, nil
}

func (r *tracedEpisodeLifecycleRepository) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return episodes.Episode{ID: lifecycleEpisodeID(), TenantID: tenantID(), SpaceID: spaceID(), Status: episodes.EpisodeStatusActive, CreatedAt: r.now()}, nil
}

func (r *tracedEpisodeLifecycleRepository) ListEpisodes(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (episodes.EpisodeList, error) {
	return episodes.EpisodeList{}, nil
}

func (r *tracedEpisodeLifecycleRepository) AdmitParticipant(_ context.Context, input episodes.AdmitParticipantInput) (episodes.Admission, error) {
	participant := episodes.Participant{ID: input.ParticipantID, TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: input.EpisodeID, IdentityID: input.IdentityID, Role: input.Role, Capabilities: []string{"subscribe"}, Generation: 1, Status: episodes.ParticipantStatusActive}
	intent := episodes.Intent{ID: lifecycleIntentID(), TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: input.EpisodeID, ParticipantID: input.ParticipantID, ParticipantGeneration: 1, RequestKey: input.Request.Key, IntentName: episodes.IntentParticipantJoined, Status: episodes.IntentStatusPending, CreatedAt: r.now()}
	return episodes.Admission{Episode: episodes.Episode{ID: input.EpisodeID, TenantID: input.TenantID, SpaceID: input.SpaceID, Status: episodes.EpisodeStatusActive, CreatedAt: r.now()}, Participant: participant, Intent: intent, JoinIntent: intent}, nil
}

func (r *tracedEpisodeLifecycleRepository) RequestParticipantRemoval(_ context.Context, input episodes.RequestParticipantRemovalInput) (episodes.Removal, error) {
	participant := episodes.Participant{ID: input.ParticipantID, TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: input.EpisodeID, Role: "collaborator", Capabilities: []string{"subscribe"}, Generation: input.ParticipantGeneration, Status: episodes.ParticipantStatusLeaving}
	intent := episodes.Intent{ID: lifecycleIntentID(), TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: input.EpisodeID, ParticipantID: input.ParticipantID, ParticipantGeneration: input.ParticipantGeneration, RequestKey: input.Request.Key, IntentName: episodes.OperationRemoveParticipant, Status: episodes.IntentStatusPending, CreatedAt: r.now()}
	return episodes.Removal{Episode: episodes.Episode{ID: input.EpisodeID, TenantID: input.TenantID, SpaceID: input.SpaceID, Status: episodes.EpisodeStatusActive, CreatedAt: r.now()}, Participant: participant, Intent: intent}, nil
}

func (r *tracedEpisodeLifecycleRepository) RequestEpisodeEnd(_ context.Context, input episodes.RequestEpisodeEndInput) (episodes.EndRequest, error) {
	intent := episodes.Intent{ID: lifecycleIntentID(), TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: input.EpisodeID, RequestKey: input.Request.Key, IntentName: episodes.OperationTenantEndEpisode, Status: episodes.IntentStatusPending, CreatedAt: r.now()}
	return episodes.EndRequest{Episode: episodes.Episode{ID: input.EpisodeID, TenantID: input.TenantID, SpaceID: input.SpaceID, Status: episodes.EpisodeStatusEnding, CreatedAt: r.now()}, Intent: intent}, nil
}

func (r *tracedEpisodeLifecycleRepository) SetDeadline(_ context.Context, input episodes.SetDeadlineInput) (episodes.ControlRequest, error) {
	operation := episodes.ExternalOperation{ID: lifecycleIntentID(), RequestKey: input.Request.Key, OperationName: episodes.OperationTenantSetDeadline, DeadlineGeneration: 2, Status: episodes.IntentStatusPending, CreatedAt: r.now()}
	return episodes.ControlRequest{Episode: episodes.Episode{ID: input.EpisodeID, TenantID: input.TenantID, SpaceID: input.SpaceID, Status: episodes.EpisodeStatusActive, CreatedAt: r.now()}, Operation: operation}, nil
}

func lifecycleEpisodeID() utilities.ID {
	return mustID("99999999-9999-4999-8999-999999999999")
}

func lifecycleIntentID() utilities.ID {
	return mustID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
}

func participantID() utilities.ID {
	return mustID("44444444-4444-4444-8444-444444444444")
}

var _ httpapi.EpisodeLifecycleService = tracedEpisodeLifecycleService{}
var _ episodes.Repository = (*tracedEpisodeLifecycleRepository)(nil)
