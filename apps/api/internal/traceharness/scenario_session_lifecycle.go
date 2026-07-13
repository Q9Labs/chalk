package traceharness

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func runRouteSessionCreateMember(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	repository := tracedSessionLifecycleRepository{recorder: recorder, now: now}
	service := tracedSessionLifecycleService{recorder: recorder, next: sessionlifecycle.NewService(repository)}

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteSessionCreateMemberScenario,
		Recorder: recorder,
		Handler: httpapi.NewRouter(httpapi.Options{
			RateLimit: noRateLimits(now),
			Authentication: staticAuthentication{
				recorder: recorder, now: now, principal: userPrincipal(), sessionUser: sessionUserFixture(now),
			},
			TenantAuthz: authorization.NewTenantPolicy(tracedMembershipRepository{
				recorder: recorder, now: now, policyRole: memberships.RoleMember,
			}),
			Rooms: tracedRoomService{
				recorder: recorder,
				next:     rooms.NewService(tracedRoomRepository{recorder: recorder, now: now}),
			},
			SessionLifecycle: service,
		}),
		Method: http.MethodPost,
		Path:   "/v1/tenants/" + tenantID().String() + "/rooms/" + roomID().String() + "/sessions",
		Body: json.RawMessage(`{
			"metadata":{"purpose":"sync-trace"},
			"admission_policy":"open",
			"host_exit_policy":"require_transfer",
			"role_capabilities":{"host":["subscribe","transferHost","endMeeting"],"cohost":["subscribe"],"participant":["subscribe"]},
			"maximum_duration_seconds":3600
		}`),
		Authorization:  "Bearer trace-session-token",
		Headers:        map[string]string{"Idempotency-Key": "session-create-trace-0001"},
		ExpectedStatus: http.StatusCreated,
	})
}

func runRouteSessionEndMember(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	repository := tracedSessionLifecycleRepository{recorder: recorder, now: now}
	service := tracedSessionLifecycleService{recorder: recorder, next: sessionlifecycle.NewService(repository)}

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteSessionEndMemberScenario,
		Recorder: recorder,
		Handler: httpapi.NewRouter(httpapi.Options{
			RateLimit: noRateLimits(now),
			Authentication: staticAuthentication{
				recorder: recorder, now: now, principal: userPrincipal(), sessionUser: sessionUserFixture(now),
			},
			TenantAuthz:      authorization.NewTenantPolicy(tracedMembershipRepository{recorder: recorder, now: now, policyRole: memberships.RoleMember}),
			SessionLifecycle: service,
		}),
		Method:         http.MethodPost,
		Path:           "/v1/tenants/" + tenantID().String() + "/rooms/" + roomID().String() + "/sessions/" + lifecycleSessionID().String() + "/end",
		Authorization:  "Bearer trace-session-token",
		Headers:        map[string]string{"Idempotency-Key": "session-end-trace-0001"},
		ExpectedStatus: http.StatusAccepted,
	})
}

func runRouteSessionSyncToken(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	issuer := tracedSyncTokenIssuer{recorder: recorder, now: now}

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteSessionSyncTokenScenario,
		Recorder: recorder,
		Handler: httpapi.NewRouter(httpapi.Options{
			RateLimit: noRateLimits(now),
			Authentication: staticAuthentication{
				recorder: recorder, now: now, principal: userPrincipal(), sessionUser: sessionUserFixture(now),
			},
			TenantAuthz: authorization.NewTenantPolicy(tracedMembershipRepository{
				recorder: recorder, now: now, policyRole: memberships.RoleMember,
			}),
			SyncTokenRefresh: issuer,
		}),
		Method:         http.MethodPost,
		Path:           "/v1/tenants/" + tenantID().String() + "/rooms/" + roomID().String() + "/sessions/" + lifecycleSessionID().String() + "/participants/" + participantID().String() + "/sync-token",
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusCreated,
	})
}

type tracedSyncTokenIssuer struct {
	recorder *Recorder
	now      func() time.Time
}

func (i tracedSyncTokenIssuer) IssueForParticipant(_ context.Context, key synctokens.SubjectKey) (synctokens.Token, error) {
	span := i.recorder.Start("service", "synctokens.Broker.IssueForParticipant", "load the active participant identity before signing", map[string]any{
		"tenant_id": key.TenantID.String(), "room_id": key.RoomID.String(), "session_id": key.SessionID.String(), "participant_session_id": key.ParticipantID.String(),
	})
	i.recorder.Add("database", "SELECT active sync token subject", "read the stored generation, signed role envelope, and admission intent", nil)
	i.recorder.Add("crypto", "Ed25519 sign JWT", "sign bounded identity claims without recording token material", map[string]any{"algorithm": "EdDSA", "key_id": "trace-key"})
	result := synctokens.Token{Value: "redacted.trace.token", ExpiresAt: i.now().Add(synctokens.Lifetime)}
	span.End("return short-lived token metadata", map[string]any{"expires_at": result.ExpiresAt.Format(time.RFC3339)}, nil)
	return result, nil
}

type tracedSessionLifecycleService struct {
	recorder *Recorder
	next     sessionlifecycle.Service
}

func (s tracedSessionLifecycleService) CreateSession(ctx context.Context, input sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error) {
	span := s.recorder.Start("service", "sessionlifecycle.Service.CreateSession", "validate request key and derive a semantic SHA-256 fingerprint", map[string]any{
		"tenant_id": input.TenantID.String(), "room_id": input.RoomID.String(), "request_key": input.Request.Key,
	})
	result, err := s.next.CreateSession(ctx, input)
	span.End("return the idempotently created Session", map[string]any{"session_id": result.ID.String(), "status": result.Status}, err)
	return result, err
}

func (s tracedSessionLifecycleService) AdmitParticipant(ctx context.Context, input sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
	return s.next.AdmitParticipant(ctx, input)
}

func (s tracedSessionLifecycleService) RequestParticipantRemoval(ctx context.Context, input sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error) {
	return s.next.RequestParticipantRemoval(ctx, input)
}

func (s tracedSessionLifecycleService) RequestSessionEnd(ctx context.Context, input sessionlifecycle.RequestSessionEndInput) (sessionlifecycle.EndRequest, error) {
	span := s.recorder.Start("service", "sessionlifecycle.Service.RequestSessionEnd", "validate request key and derive SHA-256 fingerprint", map[string]any{
		"tenant_id": input.TenantID.String(), "room_id": input.RoomID.String(), "session_id": input.SessionID.String(), "request_key": input.Request.Key,
	})
	result, err := s.next.RequestSessionEnd(ctx, input)
	span.End("return committed lifecycle intent", map[string]any{"session_status": result.Session.Status, "intent_id": result.Intent.ID.String()}, err)
	return result, err
}

func (s tracedSessionLifecycleService) TransferHost(ctx context.Context, input sessionlifecycle.TransferHostInput) (sessionlifecycle.ControlRequest, error) {
	span := s.recorder.Start("service", "sessionlifecycle.Service.TransferHost", "validate tenant host recovery request", map[string]any{"session_id": input.SessionID.String()})
	result, err := s.next.TransferHost(ctx, input)
	span.End("return tenant host recovery operation", map[string]any{"operation_id": result.Operation.ID.String()}, err)
	return result, err
}

func (s tracedSessionLifecycleService) SetDeadline(ctx context.Context, input sessionlifecycle.SetDeadlineInput) (sessionlifecycle.ControlRequest, error) {
	span := s.recorder.Start("service", "sessionlifecycle.Service.SetDeadline", "validate tenant deadline request", map[string]any{"session_id": input.SessionID.String()})
	result, err := s.next.SetDeadline(ctx, input)
	span.End("return tenant deadline operation", map[string]any{"operation_id": result.Operation.ID.String()}, err)
	return result, err
}

type tracedSessionLifecycleRepository struct {
	recorder *Recorder
	now      func() time.Time
}

func (r tracedSessionLifecycleRepository) CreateSession(_ context.Context, input sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error) {
	span := r.recorder.Start("repository", "SessionLifecycleRepository.CreateSession", "run one bounded synchronous Postgres lifecycle transaction", map[string]any{
		"request_key": input.Request.Key, "request_fingerprint": "sha256:" + shortDigest(input.Request.Fingerprint),
	})
	r.recorder.Add("database", "SELECT set_config lifecycle transaction bounds", "require synchronous commit and bound lock, statement, and transaction waits", nil)
	r.recorder.Add("database", "INSERT session_create_requests", "reserve the durable idempotency key and generated Session ID", map[string]any{"request_key": input.Request.Key, "session_id": input.ID.String()})
	r.recorder.Add("database", "INSERT room_sessions", "create the product Session", map[string]any{"session_id": input.ID.String(), "status": sessionlifecycle.SessionStatusActive})
	r.recorder.Add("database", "INSERT sync_session_control", "create the revision-zero durable control row", map[string]any{"session_id": input.ID.String(), "control_revision": 0})
	r.recorder.Add("database", "COMMIT", "make the ledger, Session, and control row visible atomically", nil)

	result := sessionlifecycle.Session{
		ID: input.ID, TenantID: input.TenantID, RoomID: input.RoomID,
		Status: sessionlifecycle.SessionStatusActive, CreatedAt: r.now(),
	}
	span.End("transaction committed", map[string]any{"session_id": result.ID.String(), "status": result.Status}, nil)
	return result, nil
}

func (r tracedSessionLifecycleRepository) AdmitParticipant(context.Context, sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
	return sessionlifecycle.Admission{}, errors.New("unexpected participant admission")
}

func (r tracedSessionLifecycleRepository) RequestParticipantRemoval(context.Context, sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error) {
	return sessionlifecycle.Removal{}, errors.New("unexpected participant removal")
}

func (r tracedSessionLifecycleRepository) RequestSessionEnd(_ context.Context, input sessionlifecycle.RequestSessionEndInput) (sessionlifecycle.EndRequest, error) {
	span := r.recorder.Start("repository", "SessionLifecycleRepository.RequestSessionEnd", "run one synchronous Postgres lifecycle transaction", map[string]any{
		"request_key": input.Request.Key, "request_fingerprint": "sha256:" + shortDigest(input.Request.Fingerprint),
	})
	r.recorder.Add("database", "SET LOCAL synchronous_commit = on", "require WAL durability before response", nil)
	r.recorder.Add("database", "SELECT sync_session_control FOR UPDATE", "serialize commands and lifecycle transitions", map[string]any{"session_id": input.SessionID.String()})
	r.recorder.Add("database", "SELECT room_sessions FOR UPDATE", "verify active product Session", map[string]any{"status": "active"})
	r.recorder.Add("database", "INSERT sync_external_operations", "persist idempotent tenant_end_session operation with pre-call authority", map[string]any{"operation_name": sessionlifecycle.OperationTenantEndSession, "status": sessionlifecycle.IntentStatusPending})
	r.recorder.Add("database", "UPDATE room_sessions SET status = ending", "stop new joins and commands", nil)
	r.recorder.Add("database", "COMMIT", "make product transition and intent visible atomically", nil)

	result := sessionlifecycle.EndRequest{
		Session: sessionlifecycle.Session{ID: input.SessionID, TenantID: input.TenantID, RoomID: input.RoomID, Status: sessionlifecycle.SessionStatusEnding, CreatedAt: r.now()},
		Intent:  sessionlifecycle.Intent{ID: lifecycleIntentID(), TenantID: input.TenantID, RoomID: input.RoomID, SessionID: input.SessionID, RequestKey: input.Request.Key, IntentName: sessionlifecycle.OperationTenantEndSession, Status: sessionlifecycle.IntentStatusPending, CreatedAt: r.now()},
	}
	span.End("transaction committed", map[string]any{"intent_id": result.Intent.ID.String(), "session_status": result.Session.Status}, nil)
	return result, nil
}

func lifecycleSessionID() utilities.ID {
	return mustID("99999999-9999-4999-8999-999999999999")
}

func lifecycleIntentID() utilities.ID {
	return mustID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
}

func participantID() utilities.ID {
	return mustID("44444444-4444-4444-8444-444444444444")
}

func shortDigest(digest [32]byte) string {
	const hex = "0123456789abcdef"
	value := make([]byte, 16)
	for index, octet := range digest[:8] {
		value[index*2] = hex[octet>>4]
		value[index*2+1] = hex[octet&0x0f]
	}
	return string(value) + "…"
}
