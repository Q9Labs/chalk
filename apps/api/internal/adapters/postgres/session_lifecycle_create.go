package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (r SessionLifecycleRepository) CreateSession(ctx context.Context, input sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error) {
	var result sessionlifecycle.Session
	var commitMetric webhookCommitMetric

	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		request, err := queries.ReserveSessionCreateRequest(ctx, sqlc.ReserveSessionCreateRequestParams{
			TenantID:           uuid(input.TenantID),
			RoomID:             uuid(input.RoomID),
			RequestKey:         input.Request.Key,
			RequestFingerprint: input.Request.Fingerprint[:],
			SessionID:          uuid(input.ID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			request, err = queries.GetSessionCreateRequest(ctx, sqlc.GetSessionCreateRequestParams{
				TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), RequestKey: input.Request.Key,
			})
			if err != nil {
				return fmt.Errorf("read session create request: %w", err)
			}
			if !bytes.Equal(request.RequestFingerprint, input.Request.Fingerprint[:]) {
				return sessionlifecycle.ErrIdempotencyConflict
			}
			session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, utilities.IDFromBytes(request.SessionID.Bytes))
			if err != nil {
				return err
			}
			result = mapLifecycleSession(session)
			return nil
		}
		if err != nil {
			return fmt.Errorf("reserve session create request: %w", err)
		}
		input.DeadlineAt = timestamp(request.CreatedAt).UTC().Truncate(time.Millisecond).Add(time.Duration(input.MaximumDurationSeconds) * time.Second)
		input.InitialControl, err = sessionlifecycle.NewInitialControlState(sessionlifecycle.InitialControlPolicy{
			AdmissionPolicy: input.AdmissionPolicy, HostExitPolicy: input.HostExitPolicy,
			RoleCapabilities: input.RoleCapabilities, MaximumDurationSeconds: input.MaximumDurationSeconds,
			MaximumDurationCeilingSeconds: input.MaximumDurationCeilingSeconds, DeadlineAt: input.DeadlineAt,
		})
		if err != nil {
			return err
		}

		roleCapabilities, err := json.Marshal(input.RoleCapabilities)
		if err != nil {
			return fmt.Errorf("encode lifecycle role capabilities: %w", err)
		}
		session, err := queries.CreateLifecycleRoomSession(ctx, sqlc.CreateLifecycleRoomSessionParams{
			ID:                            uuid(input.ID),
			Metadata:                      jsonBytes(input.Metadata),
			CreatedByUserID:               uuid(input.CreatedByUserID),
			StartedAt:                     timestamptz(input.StartedAt),
			TenantID:                      uuid(input.TenantID),
			RoomID:                        uuid(input.RoomID),
			HostExitPolicy:                input.HostExitPolicy,
			RoleCapabilities:              roleCapabilities,
			MaximumDurationSeconds:        input.MaximumDurationSeconds,
			MaximumDurationCeilingSeconds: input.MaximumDurationCeilingSeconds,
			DeadlineAt:                    timestamptz(&input.DeadlineAt),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return sessionlifecycle.ErrRoomNotFound
		}
		if uniqueConstraintViolation(err, "room_sessions_pkey") {
			return sessionlifecycle.ErrSessionAlreadyExists
		}
		if err != nil {
			return fmt.Errorf("create lifecycle room session: %w", err)
		}

		if _, err := queries.CreateSyncSessionControl(ctx, sqlc.CreateSyncSessionControlParams{
			TenantID:           uuid(input.TenantID),
			RoomID:             uuid(input.RoomID),
			SessionID:          uuid(input.ID),
			FoldedState:        jsonBytes(input.InitialControl.FoldedState),
			StateSchemaVersion: input.InitialControl.SchemaVersion,
			StateDigest:        input.InitialControl.Digest[:],
			SnapshotBytes:      input.InitialControl.SnapshotBytes,
		}); err != nil {
			return fmt.Errorf("create lifecycle control: %w", err)
		}
		snapshot := webhooks.SessionSnapshot{ID: input.ID.String(), RoomID: input.RoomID.String(), Status: session.Status, StartedAt: nullableTimestamp(session.StartedAt), EndedAt: nullableTimestamp(session.EndedAt), CreatedAt: timestamp(session.CreatedAt), UpdatedAt: timestamp(session.UpdatedAt)}
		occurredAt := timestamp(session.CreatedAt)
		if session.StartedAt.Valid {
			occurredAt = timestamp(session.StartedAt)
		}
		commitMetric, err = fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: input.TenantID, EventName: "session.started", SemanticKey: "session:" + input.ID.String() + ":started", ResourceType: "session", ResourceID: input.ID, OccurredAt: occurredAt, Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
			return webhooks.EncodeSessionEvent(metadata, snapshot)
		}})
		if err != nil {
			return fmt.Errorf("produce session.started webhook: %w", err)
		}

		result = mapLifecycleSession(session)
		return nil
	})
	if err != nil {
		return sessionlifecycle.Session{}, err
	}

	commitMetric.Record(ctx)
	return result, nil
}

func (r SessionLifecycleRepository) AdmitParticipant(ctx context.Context, input sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
	var result sessionlifecycle.Admission

	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		control, err := lockLifecycleControlRow(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
		if err != nil {
			return err
		}
		intent, err := queries.LockLifecycleIntentForRequestForUpdate(ctx, lifecycleIntentRequestParams(input, sessionlifecycle.IntentParticipantJoined))
		if err == nil {
			return resolveAdmissionRetry(ctx, queries, input, intent, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock participant admission intent: %w", err)
		}
		var authority struct {
			AdmissionPolicy string `json:"admission_policy"`
		}
		if err := json.Unmarshal(control.FoldedState, &authority); err != nil {
			return fmt.Errorf("decode lifecycle admission policy: %w", err)
		}
		session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
		if err != nil {
			return err
		}
		if session.Status != sessionlifecycle.SessionStatusActive {
			return sessionlifecycle.ErrSessionNotActive
		}

		payload := input.Request.Payload()
		switch authority.AdmissionPolicy {
		case "open":
		case "approval":
			return createApprovalAdmission(ctx, queries, tx, input, session, payload, &result)
		case "closed":
			return sessionlifecycle.ErrAdmissionClosed
		default:
			return sessionlifecycle.ErrInvalidAdmissionPolicy
		}

		if _, err := queries.ReserveParticipantAdmission(ctx, sqlc.ReserveParticipantAdmissionParams{
			SnapshotReservationBytes: sessionlifecycle.ParticipantSnapshotReservationBytes,
			ReservationBytes:         sessionlifecycle.LifecycleReservationBytes,
			IntentPayloadBytes:       int64(len(payload)),
			MaxActiveParticipants:    sessionlifecycle.MaximumActiveParticipantSessions,
			TenantID:                 uuid(input.TenantID),
			RoomID:                   uuid(input.RoomID),
			SessionID:                uuid(input.SessionID),
		}); errors.Is(err, pgx.ErrNoRows) {
			return sessionlifecycle.ErrCapacityExceeded
		} else if err != nil {
			return fmt.Errorf("reserve participant admission capacity: %w", err)
		}

		participant, err := queries.CreateLifecycleParticipant(ctx, sqlc.CreateLifecycleParticipantParams{
			ID: uuid(input.ParticipantID), Name: pgtype.Text{String: input.Name, Valid: true},
			Metadata: jsonBytes(input.Metadata), InitialRole: input.InitialRole,
			EligibleRoles: append([]string(nil), input.EligibleRoles...), TenantID: uuid(input.TenantID),
			RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID), UserID: uuid(input.UserID),
		})
		if err != nil {
			return fmt.Errorf("create lifecycle participant: %w", err)
		}

		intentID, err := utilities.NewID()
		if err != nil {
			return fmt.Errorf("create lifecycle intent id: %w", err)
		}
		journey, err := lifecycleJourneyFromContext(ctx)
		if err != nil {
			return err
		}
		if err := persistLifecycleJourneyRoot(ctx, tx, journey, "participant.admission_requested"); err != nil {
			return err
		}
		intent, err = queries.CreateLifecycleIntent(ctx, sqlc.CreateLifecycleIntentParams{
			TenantID:                     uuid(input.TenantID),
			RoomID:                       uuid(input.RoomID),
			SessionID:                    uuid(input.SessionID),
			LifecycleIntentID:            uuid(intentID),
			RequestKey:                   input.Request.Key,
			RequestFingerprint:           input.Request.Fingerprint[:],
			IntentName:                   sessionlifecycle.IntentParticipantJoined,
			ParticipantSessionID:         uuid(input.ParticipantID),
			ParticipantSessionGeneration: pgtype.Int8{Int64: participant.Generation, Valid: true},
			Payload:                      jsonBytes(payload),
			JourneyID:                    uuid(journey.JourneyID),
			ParentJourneyEventID:         uuid(journey.ParentEventID),
			ProducingTraceID:             optionalText(journey.TraceID),
			ProducingSpanID:              optionalText(journey.SpanID),
		})
		if err != nil {
			return fmt.Errorf("create participant admission intent: %w", err)
		}

		result = sessionlifecycle.Admission{
			Session:     mapLifecycleSession(session),
			Participant: mapLifecycleParticipant(participant),
			Intent:      mapLifecycleIntent(intent),
			JoinIntent:  mapLifecycleIntent(intent),
		}
		return nil
	})
	if err != nil {
		return sessionlifecycle.Admission{}, err
	}

	return result, nil
}

func createApprovalAdmission(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input sessionlifecycle.AdmitParticipantInput, session sqlc.RoomSession, joinPayload []byte, result *sessionlifecycle.Admission) error {
	admissionRequestID, err := utilities.NewID()
	if err != nil {
		return fmt.Errorf("create admission request id: %w", err)
	}
	requestedIntentID, err := utilities.NewID()
	if err != nil {
		return fmt.Errorf("create admission requested intent id: %w", err)
	}
	joinIntentID, err := utilities.NewID()
	if err != nil {
		return fmt.Errorf("create deferred participant join intent id: %w", err)
	}
	expiresAt := time.Now().UTC().Add(sessionlifecycle.AdmissionRequestLifetime).Truncate(time.Millisecond)
	requestedPayload, err := json.Marshal(struct {
		AdmissionRequestID   string   `json:"admission_request_id"`
		ParticipantSessionID string   `json:"participant_session_id"`
		DisplayName          string   `json:"display_name"`
		InitialRole          string   `json:"initial_role"`
		EligibleRoles        []string `json:"eligible_roles"`
		ExpiresAtMillis      int64    `json:"expires_at_ms"`
	}{
		AdmissionRequestID: admissionRequestID.String(), ParticipantSessionID: input.ParticipantID.String(),
		DisplayName: input.Name, InitialRole: input.InitialRole, EligibleRoles: input.EligibleRoles,
		ExpiresAtMillis: expiresAt.UnixMilli(),
	})
	if err != nil {
		return fmt.Errorf("encode admission requested payload: %w", err)
	}

	if _, err := queries.ReserveApprovalAdmission(ctx, sqlc.ReserveApprovalAdmissionParams{
		SnapshotReservationBytes: sessionlifecycle.ParticipantSnapshotReservationBytes,
		ReservationBytes:         sessionlifecycle.LifecycleReservationBytes,
		RequestedPayloadBytes:    int64(len(requestedPayload)),
		JoinPayloadBytes:         int64(len(joinPayload)),
		TenantID:                 uuid(input.TenantID),
		RoomID:                   uuid(input.RoomID),
		SessionID:                uuid(input.SessionID),
		MaxActiveParticipants:    sessionlifecycle.MaximumActiveParticipantSessions,
	}); errors.Is(err, pgx.ErrNoRows) {
		return sessionlifecycle.ErrCapacityExceeded
	} else if err != nil {
		return fmt.Errorf("reserve approval admission capacity: %w", err)
	}

	participant, err := queries.CreateLifecycleParticipant(ctx, sqlc.CreateLifecycleParticipantParams{
		ID: uuid(input.ParticipantID), Name: pgtype.Text{String: input.Name, Valid: true},
		Metadata: jsonBytes(input.Metadata), InitialRole: input.InitialRole,
		EligibleRoles: append([]string(nil), input.EligibleRoles...), TenantID: uuid(input.TenantID),
		RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID), UserID: uuid(input.UserID),
	})
	if err != nil {
		return fmt.Errorf("create approval lifecycle participant: %w", err)
	}

	journey, err := lifecycleJourneyFromContext(ctx)
	if err != nil {
		return err
	}
	if err := persistLifecycleJourneyRoot(ctx, tx, journey, "participant.admission_requested"); err != nil {
		return err
	}
	requestedIntent, err := queries.CreateLifecycleIntent(ctx, sqlc.CreateLifecycleIntentParams{
		TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
		LifecycleIntentID: uuid(requestedIntentID), RequestKey: input.Request.Key,
		RequestFingerprint: input.Request.Fingerprint[:], IntentName: sessionlifecycle.IntentAdmissionRequested,
		Payload: jsonBytes(requestedPayload), JourneyID: uuid(journey.JourneyID), ParentJourneyEventID: uuid(journey.ParentEventID),
		ProducingTraceID: optionalText(journey.TraceID), ProducingSpanID: optionalText(journey.SpanID),
	})
	if err != nil {
		return fmt.Errorf("create admission requested intent: %w", err)
	}
	joinIntent, err := queries.CreateDeferredLifecycleIntent(ctx, sqlc.CreateDeferredLifecycleIntentParams{
		TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
		LifecycleIntentID: uuid(joinIntentID), RequestKey: input.Request.Key,
		RequestFingerprint: input.Request.Fingerprint[:], IntentName: sessionlifecycle.IntentParticipantJoined,
		ParticipantSessionID: uuid(input.ParticipantID), ParticipantSessionGeneration: pgtype.Int8{Int64: participant.Generation, Valid: true},
		Payload: jsonBytes(joinPayload), JourneyID: uuid(journey.JourneyID), ParentJourneyEventID: uuid(journey.ParentEventID),
		ProducingTraceID: optionalText(journey.TraceID), ProducingSpanID: optionalText(journey.SpanID),
	})
	if err != nil {
		return fmt.Errorf("create deferred participant join intent: %w", err)
	}
	admissionRequest, err := queries.CreateAdmissionRequest(ctx, sqlc.CreateAdmissionRequestParams{
		TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
		AdmissionRequestID: uuid(admissionRequestID), RequestKey: input.Request.Key,
		RequestFingerprint: input.Request.Fingerprint[:], ParticipantSessionID: uuid(input.ParticipantID),
		DisplayName: input.Name, InitialRole: input.InitialRole, EligibleRoles: append([]string(nil), input.EligibleRoles...),
		ExpiresAt: timestamptz(&expiresAt),
	})
	if err != nil {
		return fmt.Errorf("create admission request: %w", err)
	}

	*result = sessionlifecycle.Admission{
		Session: mapLifecycleSession(session), Participant: mapLifecycleParticipant(participant),
		Intent: mapLifecycleIntent(requestedIntent), JoinIntent: mapLifecycleIntent(joinIntent),
		AdmissionRequest: mapAdmissionRequest(admissionRequest),
	}
	return nil
}

func resolveAdmissionRetry(ctx context.Context, queries *sqlc.Queries, input sessionlifecycle.AdmitParticipantInput, intent sqlc.SyncLifecycleIntent, result *sessionlifecycle.Admission) error {
	if err := idempotencyConflict(intent, input.Request); err != nil {
		return err
	}

	session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
	if err != nil {
		return err
	}
	participant, err := lockLifecycleParticipant(ctx, queries, input.TenantID, input.RoomID, input.SessionID, nullableID(intent.ParticipantSessionID))
	if err != nil {
		return err
	}

	admission := sessionlifecycle.Admission{
		Session:     mapLifecycleSession(session),
		Participant: mapLifecycleParticipant(participant),
		Intent:      mapLifecycleIntent(intent),
		JoinIntent:  mapLifecycleIntent(intent),
	}
	request, err := queries.LockAdmissionRequestForParticipant(ctx, sqlc.LockAdmissionRequestForParticipantParams{
		TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
		ParticipantSessionID: participant.ID,
	})
	if err == nil {
		if !bytes.Equal(request.RequestFingerprint, input.Request.Fingerprint[:]) {
			return sessionlifecycle.ErrIdempotencyConflict
		}
		requestedIntent, err := queries.LockLifecycleIntentForRequestForUpdate(ctx, lifecycleIntentRequestParams(input, sessionlifecycle.IntentAdmissionRequested))
		if err != nil {
			return fmt.Errorf("lock admission requested intent: %w", err)
		}
		admission.Intent = mapLifecycleIntent(requestedIntent)
		admission.AdmissionRequest = mapAdmissionRequest(request)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("lock admission request: %w", err)
	}
	*result = admission
	return nil
}

func mapAdmissionRequest(row sqlc.SyncAdmissionRequest) *sessionlifecycle.AdmissionRequest {
	return &sessionlifecycle.AdmissionRequest{
		ID: utilities.IDFromBytes(row.AdmissionRequestID.Bytes), Status: row.Status, ExpiresAt: timestamp(row.ExpiresAt),
	}
}

func lifecycleIntentRequestParams(input sessionlifecycle.AdmitParticipantInput, intentName string) sqlc.LockLifecycleIntentForRequestForUpdateParams {
	return sqlc.LockLifecycleIntentForRequestForUpdateParams{
		TenantID:   uuid(input.TenantID),
		RoomID:     uuid(input.RoomID),
		SessionID:  uuid(input.SessionID),
		IntentName: intentName,
		RequestKey: input.Request.Key,
	}
}
