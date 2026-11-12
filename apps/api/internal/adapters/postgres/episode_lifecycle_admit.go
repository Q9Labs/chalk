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
)

func (r EpisodeLifecycleRepository) AdmitParticipant(ctx context.Context, input episodes.AdmitParticipantInput) (episodes.Admission, error) {
	var result episodes.Admission
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		return admitParticipant(ctx, queries, tx, input, &result)
	})
	if err != nil {
		return episodes.Admission{}, err
	}
	return result, nil
}

func admitParticipant(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input episodes.AdmitParticipantInput, result *episodes.Admission) error {
	space, err := queries.LockTenantSpaceForUpdate(ctx, sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(input.TenantID), ID: uuid(input.SpaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return episodes.ErrSpaceNotFound
	}
	if err != nil {
		return fmt.Errorf("lock participant admission space: %w", err)
	}
	if _, err := lockLifecycleControlRow(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
		return err
	}
	intent, err := queries.LockLifecycleIntentForRequestForUpdate(ctx, lifecycleIntentRequestParams(input, episodes.IntentParticipantJoined))
	if err == nil {
		return resolveAdmissionRetry(ctx, queries, tx, input, intent, result)
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
	if input.IdentityExternalID != "" {
		if input.IdentityID, err = resolveAdmissionIdentity(ctx, queries, input); err != nil {
			return err
		}
	}
	payload := input.Request.Payload()
	if input.Admission != episodes.AdmissionDirect {
		mode, err := configAdmissionMode(config.AdmissionPolicy)
		if err != nil {
			return err
		}
		switch mode {
		case "open":
		case "knock":
			return createKnockAdmission(ctx, queries, tx, input, episode, roleCapabilities, payload, result)
		case "members_only":
			return episodes.ErrAdmissionClosed
		default:
			return episodes.ErrInvalidAdmissionPolicy
		}
	}
	return createOpenAdmission(ctx, queries, tx, input, episode, roleCapabilities, payload, result)
}

func resolveAdmissionIdentity(ctx context.Context, queries *sqlc.Queries, input episodes.AdmitParticipantInput) (utilities.ID, error) {
	identityID, err := utilities.NewID()
	if err != nil {
		return utilities.ID{}, fmt.Errorf("allocate admission identity: %w", err)
	}
	identity, err := queries.ResolveAdmissionIdentity(ctx, sqlc.ResolveAdmissionIdentityParams{
		ID: uuid(identityID), TenantID: uuid(input.TenantID), ExternalID: input.IdentityExternalID, DisplayName: input.Name,
	})
	if err != nil {
		return utilities.ID{}, fmt.Errorf("resolve admission identity: %w", err)
	}
	return utilities.IDFromBytes(identity.Bytes), nil
}

// createOpenAdmission admits the participant at once: it reserves capacity, seats them and records the
// join intent.
func createOpenAdmission(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input episodes.AdmitParticipantInput, episode sqlc.Episode, capabilities []string, payload []byte, result *episodes.Admission) error {
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
		Capabilities: append([]string(nil), capabilities...), Role: input.Role,
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), IdentityID: uuid(input.IdentityID),
	})
	if err != nil {
		return fmt.Errorf("create lifecycle participant: %w", err)
	}
	if err := createParticipantJoinSeat(ctx, tx, participant); err != nil {
		return err
	}
	intent, err := createOpenAdmissionIntent(ctx, queries, tx, input, participant, payload)
	if err != nil {
		return err
	}
	*result = episodes.Admission{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(intent), JoinIntent: mapLifecycleIntent(intent)}
	return nil
}

func createOpenAdmissionIntent(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input episodes.AdmitParticipantInput, participant sqlc.Participant, payload []byte) (sqlc.SyncLifecycleIntent, error) {
	intentID, err := utilities.NewID()
	if err != nil {
		return sqlc.SyncLifecycleIntent{}, fmt.Errorf("create lifecycle intent id: %w", err)
	}
	journey, err := lifecycleJourneyFromContext(ctx)
	if err != nil {
		return sqlc.SyncLifecycleIntent{}, err
	}
	// Policy admissions keep their record; absence of the attribute means policy.
	var rootAttributes map[string]string
	if input.Admission == episodes.AdmissionDirect {
		rootAttributes = map[string]string{"admission": string(episodes.AdmissionDirect)}
	}
	if err := persistLifecycleJourneyRootWith(ctx, tx, journey, "participant.admission_requested", rootAttributes); err != nil {
		return sqlc.SyncLifecycleIntent{}, err
	}
	intent, err := queries.CreateLifecycleIntent(ctx, sqlc.CreateLifecycleIntentParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID), LifecycleIntentID: uuid(intentID),
		RequestKey: input.Request.Key, RequestFingerprint: input.Request.Fingerprint[:], IntentName: episodes.IntentParticipantJoined,
		ParticipantID: uuid(input.ParticipantID), ParticipantGeneration: pgtype.Int8{Int64: participant.Generation, Valid: true}, Payload: jsonBytes(payload),
		JourneyID: uuid(journey.JourneyID), ParentJourneyEventID: uuid(journey.ParentEventID), ProducingTraceID: optionalText(journey.TraceID), ProducingSpanID: optionalText(journey.SpanID),
	})
	if err != nil {
		return intent, fmt.Errorf("create participant admission intent: %w", err)
	}
	if _, err := tx.Exec(ctx, `update sync_lifecycle_intents set next_attempt_at = seat.expires_at
            from participant_join_seats seat where sync_lifecycle_intents.tenant_id=seat.tenant_id
            and sync_lifecycle_intents.episode_id=seat.episode_id
            and sync_lifecycle_intents.participant_id=seat.participant_id
            and sync_lifecycle_intents.lifecycle_intent_id=$1`, uuid(intentID)); err != nil {
		return intent, fmt.Errorf("schedule pending join expiry: %w", err)
	}
	return intent, nil
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

func resolveAdmissionRetry(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input episodes.AdmitParticipantInput, intent sqlc.SyncLifecycleIntent, result *episodes.Admission) error {
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
	if err := retryParticipantJoinSeat(ctx, tx, participant); err != nil {
		return err
	}
	participant, err = lockLifecycleParticipant(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID, nullableID(intent.ParticipantID))
	if err != nil {
		return err
	}
	intent, err = queries.LockLifecycleIntentForRequestForUpdate(ctx, lifecycleIntentRequestParams(input, episodes.IntentParticipantJoined))
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
