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
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (r EpisodeLifecycleRepository) CreateEpisode(ctx context.Context, input episodes.CreateEpisodeInput) (episodes.Episode, error) {
	var result episodes.Episode
	var commitMetric webhookCommitMetric

	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		request, err := queries.ReserveEpisodeCreateRequest(ctx, sqlc.ReserveEpisodeCreateRequestParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestKey: input.Request.Key,
			RequestFingerprint: input.Request.Fingerprint[:], EpisodeID: uuid(input.ID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			request, err = queries.GetEpisodeCreateRequest(ctx, sqlc.GetEpisodeCreateRequestParams{
				TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestKey: input.Request.Key,
			})
			if err != nil {
				return fmt.Errorf("read episode create request: %w", err)
			}
			if !bytes.Equal(request.RequestFingerprint, input.Request.Fingerprint[:]) {
				return episodes.ErrIdempotencyConflict
			}
			episode, err := lockLifecycleEpisode(ctx, queries, input.TenantID, input.SpaceID, utilities.IDFromBytes(request.EpisodeID.Bytes))
			if err != nil {
				return err
			}
			result = mapLifecycleEpisode(episode)
			return nil
		}
		if err != nil {
			return fmt.Errorf("reserve episode create request: %w", err)
		}

		if input.DeadlineAt.IsZero() {
			space, err := queries.GetTenantSpace(ctx, sqlc.GetTenantSpaceParams{TenantID: uuid(input.TenantID), ID: uuid(input.SpaceID)})
			if errors.Is(err, pgx.ErrNoRows) {
				return episodes.ErrSpaceNotFound
			}
			if err != nil {
				return fmt.Errorf("read episode space policy: %w", err)
			}
			input.DeadlineAt = timestamp(request.CreatedAt).UTC().Truncate(time.Millisecond).Add(time.Duration(space.DefaultEpisodeDurationSeconds) * time.Second)
		} else {
			input.DeadlineAt = input.DeadlineAt.UTC().Truncate(time.Millisecond)
		}

		episode, err := queries.CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{
			ID: uuid(input.ID), Metadata: jsonBytes(input.Metadata), CreatedByUserID: uuid(input.CreatedByUserID),
			StartedAt: timestamptz(input.StartedAt), DeadlineAt: timestamptz(&input.DeadlineAt),
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrSpaceNotFound
		}
		if episodeAlreadyExists(err) {
			return episodes.ErrEpisodeAlreadyExists
		}
		if err != nil {
			return fmt.Errorf("create lifecycle episode: %w", err)
		}

		initialControl, err := episodes.NewInitialControlState(episodes.InitialControlPolicy{
			ConfigSnapshot:     episode.ConfigSnapshot,
			DeadlineAt:         timestamp(episode.DeadlineAt),
			DeadlineGeneration: episode.DeadlineGeneration,
		})
		if err != nil {
			return err
		}
		if _, err := queries.CreateSyncEpisodeControl(ctx, sqlc.CreateSyncEpisodeControlParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.ID),
			FoldedState: jsonBytes(initialControl.FoldedState), StateSchemaVersion: initialControl.SchemaVersion,
			StateDigest: initialControl.Digest[:], SnapshotBytes: initialControl.SnapshotBytes,
		}); err != nil {
			return fmt.Errorf("create episode control: %w", err)
		}

		snapshot := webhooks.EpisodeSnapshot{
			ID: input.ID.String(), SpaceID: input.SpaceID.String(), Status: episode.Status,
			StartedAt: nullableTimestamp(episode.StartedAt), EndedAt: nullableTimestamp(episode.EndedAt),
			CreatedAt: timestamp(episode.CreatedAt), UpdatedAt: timestamp(episode.UpdatedAt),
		}
		occurredAt := timestamp(episode.CreatedAt)
		if episode.StartedAt.Valid {
			occurredAt = timestamp(episode.StartedAt)
		}
		commitMetric, err = fanoutWebhookEvent(ctx, tx, webhookProduction{
			TenantID: input.TenantID, EventName: "episode.started", SemanticKey: "episode:" + input.ID.String() + ":started",
			ResourceType: "episode", ResourceID: input.ID, OccurredAt: occurredAt,
			Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
				return webhooks.EncodeEpisodeEvent(metadata, snapshot)
			},
		})
		if err != nil {
			return fmt.Errorf("produce episode.started webhook: %w", err)
		}

		result = mapLifecycleEpisode(episode)
		return nil
	})
	if err != nil {
		return episodes.Episode{}, err
	}
	commitMetric.Record(ctx)
	return result, nil
}

func episodeAlreadyExists(err error) bool {
	return uniqueConstraintViolation(err, "episodes_pkey") || uniqueConstraintViolation(err, "episodes_one_live_per_space_idx")
}

func (r EpisodeLifecycleRepository) AdmitParticipant(ctx context.Context, input episodes.AdmitParticipantInput) (episodes.Admission, error) {
	var result episodes.Admission

	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		space, err := queries.LockTenantSpaceForUpdate(ctx, sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(input.TenantID), ID: uuid(input.SpaceID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrSpaceNotFound
		}
		if err != nil {
			return fmt.Errorf("lock participant admission space: %w", err)
		}
		_, err = lockLifecycleControlRow(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID)
		if err != nil {
			return err
		}
		intent, err := queries.LockLifecycleIntentForRequestForUpdate(ctx, lifecycleIntentRequestParams(input, episodes.IntentParticipantJoined))
		if err == nil {
			return resolveAdmissionRetry(ctx, queries, input, intent, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock participant admission intent: %w", err)
		}
		// The Space lock makes this check authoritative against archive/restore.
		// A replay found above still returns its committed admission, while a
		// fresh request must not create a participant in an archived Space.
		if space.ArchivedAt.Valid {
			return episodes.ErrAdmissionClosed
		}

		episode, err := lockLifecycleEpisode(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID)
		if err != nil {
			return err
		}
		if episode.Status != episodes.EpisodeStatusActive {
			return episodes.ErrEpisodeNotActive
		}
		config, err := episodeConfig(episode.ConfigSnapshot)
		if err != nil {
			return err
		}
		roleCapabilities, ok := config.Roles[input.Role]
		if !ok {
			return episodes.ErrInvalidRole
		}
		mode, err := configAdmissionMode(config.AdmissionPolicy)
		if err != nil {
			return err
		}
		payload := input.Request.Payload()
		switch mode {
		case "open":
		case "knock":
			return createKnockAdmission(ctx, queries, tx, input, episode, roleCapabilities, payload, &result)
		case "members_only":
			return episodes.ErrAdmissionClosed
		default:
			return episodes.ErrInvalidAdmissionPolicy
		}

		if _, err := queries.ReserveParticipantAdmission(ctx, sqlc.ReserveParticipantAdmissionParams{
			SnapshotReservationBytes: episodes.ParticipantSnapshotReservationBytes, ReservationBytes: episodes.LifecycleReservationBytes,
			IntentPayloadBytes: int64(len(payload)), MaxActiveParticipants: episodes.MaximumActiveParticipants,
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
		}); errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrCapacityExceeded
		} else if err != nil {
			return fmt.Errorf("reserve participant admission capacity: %w", err)
		}

		participant, err := queries.CreateLifecycleParticipant(ctx, sqlc.CreateLifecycleParticipantParams{
			ID: uuid(input.ParticipantID), Name: pgtype.Text{String: input.Name, Valid: true}, Metadata: jsonBytes(input.Metadata),
			Capabilities: append([]string(nil), roleCapabilities...), Role: input.Role,
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), IdentityID: uuid(input.IdentityID),
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
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), LifecycleIntentID: uuid(intentID),
			RequestKey: input.Request.Key, RequestFingerprint: input.Request.Fingerprint[:], IntentName: episodes.IntentParticipantJoined,
			ParticipantID: uuid(input.ParticipantID), ParticipantGeneration: pgtype.Int8{Int64: participant.Generation, Valid: true}, Payload: jsonBytes(payload),
			JourneyID: uuid(journey.JourneyID), ParentJourneyEventID: uuid(journey.ParentEventID), ProducingTraceID: optionalText(journey.TraceID), ProducingSpanID: optionalText(journey.SpanID),
		})
		if err != nil {
			return fmt.Errorf("create participant admission intent: %w", err)
		}
		result = episodes.Admission{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(intent), JoinIntent: mapLifecycleIntent(intent)}
		return nil
	})
	if err != nil {
		return episodes.Admission{}, err
	}
	return result, nil
}

func createKnockAdmission(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input episodes.AdmitParticipantInput, episode sqlc.Episode, capabilities []string, joinPayload []byte, result *episodes.Admission) error {
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
	expiresAt := time.Now().UTC().Add(episodes.AdmissionRequestLifetime).Truncate(time.Millisecond)
	requestedPayload, err := json.Marshal(struct {
		AdmissionRequestID string `json:"admission_request_id"`
		ParticipantID      string `json:"participant_id"`
		DisplayName        string `json:"display_name"`
		Role               string `json:"role"`
		ExpiresAtMillis    int64  `json:"expires_at_ms"`
	}{AdmissionRequestID: admissionRequestID.String(), ParticipantID: input.ParticipantID.String(), DisplayName: input.Name, Role: input.Role, ExpiresAtMillis: expiresAt.UnixMilli()})
	if err != nil {
		return fmt.Errorf("encode admission requested payload: %w", err)
	}
	if _, err := queries.ReserveKnockAdmission(ctx, sqlc.ReserveKnockAdmissionParams{
		SnapshotReservationBytes: episodes.ParticipantSnapshotReservationBytes, ReservationBytes: episodes.LifecycleReservationBytes,
		RequestedPayloadBytes: int64(len(requestedPayload)), JoinPayloadBytes: int64(len(joinPayload)), TenantID: uuid(input.TenantID),
		SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), MaxActiveParticipants: episodes.MaximumActiveParticipants,
	}); errors.Is(err, pgx.ErrNoRows) {
		return episodes.ErrCapacityExceeded
	} else if err != nil {
		return fmt.Errorf("reserve knock admission capacity: %w", err)
	}
	participant, err := queries.CreateLifecycleParticipant(ctx, sqlc.CreateLifecycleParticipantParams{
		ID: uuid(input.ParticipantID), Name: pgtype.Text{String: input.Name, Valid: true}, Metadata: jsonBytes(input.Metadata), Capabilities: append([]string(nil), capabilities...), Role: input.Role,
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), IdentityID: uuid(input.IdentityID),
	})
	if err != nil {
		return fmt.Errorf("create knock lifecycle participant: %w", err)
	}
	journey, err := lifecycleJourneyFromContext(ctx)
	if err != nil {
		return err
	}
	if err := persistLifecycleJourneyRoot(ctx, tx, journey, "participant.admission_requested"); err != nil {
		return err
	}
	requestedIntent, err := queries.CreateLifecycleIntent(ctx, sqlc.CreateLifecycleIntentParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), LifecycleIntentID: uuid(requestedIntentID), RequestKey: input.Request.Key,
		RequestFingerprint: input.Request.Fingerprint[:], IntentName: episodes.IntentAdmissionRequested, Payload: jsonBytes(requestedPayload), JourneyID: uuid(journey.JourneyID), ParentJourneyEventID: uuid(journey.ParentEventID), ProducingTraceID: optionalText(journey.TraceID), ProducingSpanID: optionalText(journey.SpanID),
	})
	if err != nil {
		return fmt.Errorf("create admission requested intent: %w", err)
	}
	joinIntent, err := queries.CreateDeferredLifecycleIntent(ctx, sqlc.CreateDeferredLifecycleIntentParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), LifecycleIntentID: uuid(joinIntentID), RequestKey: input.Request.Key,
		RequestFingerprint: input.Request.Fingerprint[:], IntentName: episodes.IntentParticipantJoined, ParticipantID: uuid(input.ParticipantID), ParticipantGeneration: pgtype.Int8{Int64: participant.Generation, Valid: true}, Payload: jsonBytes(joinPayload), JourneyID: uuid(journey.JourneyID), ParentJourneyEventID: uuid(journey.ParentEventID), ProducingTraceID: optionalText(journey.TraceID), ProducingSpanID: optionalText(journey.SpanID),
	})
	if err != nil {
		return fmt.Errorf("create deferred participant join intent: %w", err)
	}
	admissionRequest, err := queries.CreateAdmissionRequest(ctx, sqlc.CreateAdmissionRequestParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), AdmissionRequestID: uuid(admissionRequestID), RequestKey: input.Request.Key, RequestFingerprint: input.Request.Fingerprint[:], ParticipantID: uuid(input.ParticipantID), DisplayName: input.Name, Role: input.Role, ExpiresAt: timestamptz(&expiresAt),
	})
	if err != nil {
		return fmt.Errorf("create admission request: %w", err)
	}
	*result = episodes.Admission{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(requestedIntent), JoinIntent: mapLifecycleIntent(joinIntent), AdmissionRequest: mapAdmissionRequest(admissionRequest)}
	return nil
}

func resolveAdmissionRetry(ctx context.Context, queries *sqlc.Queries, input episodes.AdmitParticipantInput, intent sqlc.SyncLifecycleIntent, result *episodes.Admission) error {
	if err := idempotencyConflict(intent, input.Request); err != nil {
		return err
	}
	episode, err := lockLifecycleEpisode(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID)
	if err != nil {
		return err
	}
	participant, err := lockLifecycleParticipant(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID, nullableID(intent.ParticipantID))
	if err != nil {
		return err
	}
	admission := episodes.Admission{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(intent), JoinIntent: mapLifecycleIntent(intent)}
	request, err := queries.LockAdmissionRequestForParticipant(ctx, sqlc.LockAdmissionRequestForParticipantParams{TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), ParticipantID: participant.ID})
	if err == nil {
		if !bytes.Equal(request.RequestFingerprint, input.Request.Fingerprint[:]) {
			return episodes.ErrIdempotencyConflict
		}
		requestedIntent, err := queries.LockLifecycleIntentForRequestForUpdate(ctx, lifecycleIntentRequestParams(input, episodes.IntentAdmissionRequested))
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

func mapAdmissionRequest(row sqlc.SyncAdmissionRequest) *episodes.AdmissionRequest {
	return &episodes.AdmissionRequest{ID: utilities.IDFromBytes(row.AdmissionRequestID.Bytes), Status: row.Status, ExpiresAt: timestamp(row.ExpiresAt)}
}

func lifecycleIntentRequestParams(input episodes.AdmitParticipantInput, intentName string) sqlc.LockLifecycleIntentForRequestForUpdateParams {
	return sqlc.LockLifecycleIntentForRequestForUpdateParams{TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), IntentName: intentName, RequestKey: input.Request.Key}
}

func episodeConfig(raw []byte) (episodes.EpisodeConfigSnapshot, error) {
	var config episodes.EpisodeConfigSnapshot
	if err := json.Unmarshal(raw, &config); err != nil {
		return episodes.EpisodeConfigSnapshot{}, episodes.ErrInvalidConfigSnapshot
	}
	return config, nil
}

func configAdmissionMode(raw json.RawMessage) (string, error) {
	var policy struct {
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(raw, &policy); err != nil {
		return "", episodes.ErrInvalidAdmissionPolicy
	}
	if policy.Mode != "open" && policy.Mode != "knock" && policy.Mode != "members_only" {
		return "", episodes.ErrInvalidAdmissionPolicy
	}
	return policy.Mode, nil
}
