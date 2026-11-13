package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r PublicInviteRepository) DecideAdmissionRequest(ctx context.Context, input publicinvites.DecideAdmissionRequestInput) (publicinvites.AdmissionRequest, publicinvites.Arrival, error) {
	request, err := r.GetAdmissionRequest(ctx, input.TenantID, input.SpaceID, input.RequestHandle)
	if err != nil {
		return publicinvites.AdmissionRequest{}, publicinvites.Arrival{}, err
	}
	arrival, err := r.GetArrival(ctx, request.ArrivalHandle)
	if err != nil {
		return publicinvites.AdmissionRequest{}, publicinvites.Arrival{}, err
	}
	decision := &admissionDecision{input: input, arrivalHandle: arrival.ArrivalHandle}
	err = r.lifecycle.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		decision.queries, decision.tx = queries, tx
		return decision.run(ctx)
	})
	if err != nil {
		return publicinvites.AdmissionRequest{}, publicinvites.Arrival{}, err
	}
	if decision.legacy {
		return r.decideLegacyAdmissionRequest(ctx, input)
	}
	request, err = r.GetAdmissionRequest(ctx, input.TenantID, input.SpaceID, input.RequestHandle)
	return request, arrival, err
}

// admissionDecision is one decision transaction. legacy is set when the request has no canonical
// Episode admission, which a previous API created.
// TRIPWIRE(api-db, 2026-12-15): remove the legacy path once no pending public request lacks an
// Episode admission.
type admissionDecision struct {
	queries       *sqlc.Queries
	tx            pgx.Tx
	input         publicinvites.DecideAdmissionRequestInput
	arrivalHandle utilities.ID
	legacy        bool
}

// decisionRows are the rows a decision locks, in the order Sync locks them.
type decisionRows struct {
	invite  sqlc.SpacePublicInvite
	space   sqlc.Space
	episode sqlc.Episode
	live    sqlc.SyncAdmissionRequest
}

func (d *admissionDecision) run(ctx context.Context) error {
	input := d.input
	// Match Sync's lock order: control, Episode, admission request.
	live, err := d.queries.GetPublicEpisodeAdmission(ctx, sqlc.GetPublicEpisodeAdmissionParams{TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestHandle: uuid(input.RequestHandle)})
	if errors.Is(err, pgx.ErrNoRows) {
		d.legacy = true
		return nil
	}
	if err != nil {
		return err
	}
	rows, err := d.lockRows(ctx, live)
	if err != nil {
		return err
	}
	operationName := "admit_participant"
	if input.Decision == publicinvites.DecisionDeny {
		operationName = "deny_admission"
	}
	if done, err := d.settled(ctx, rows.live, operationName); err != nil || done {
		return err
	}
	return d.record(ctx, rows, operationName)
}

func (d *admissionDecision) lockRows(ctx context.Context, live sqlc.SyncAdmissionRequest) (decisionRows, error) {
	input := d.input
	// Arrival creation holds the invite while its Space foreign key is
	// checked, so take the invite before the Space here too.
	invite, err := d.queries.LockSpacePublicInvite(ctx, sqlc.LockSpacePublicInviteParams{TenantID: live.TenantID, SpaceID: live.SpaceID})
	if err != nil {
		return decisionRows{}, err
	}
	space, err := d.queries.LockTenantSpaceForAdmission(ctx, sqlc.LockTenantSpaceForAdmissionParams{TenantID: live.TenantID, ID: live.SpaceID})
	if err != nil {
		return decisionRows{}, err
	}
	episodeID := utilities.IDFromBytes(live.EpisodeID.Bytes)
	if _, err := lockLifecycleControlRow(ctx, d.queries, input.TenantID, input.SpaceID, episodeID); err != nil {
		return decisionRows{}, err
	}
	episode, err := lockLifecycleEpisode(ctx, d.queries, input.TenantID, input.SpaceID, episodeID)
	if err != nil {
		return decisionRows{}, err
	}
	live, err = d.queries.LockPublicEpisodeAdmission(ctx, sqlc.LockPublicEpisodeAdmissionParams{TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestHandle: uuid(input.RequestHandle)})
	if err != nil {
		return decisionRows{}, err
	}
	return decisionRows{invite: invite, space: space, episode: episode, live: live}, nil
}

// settled reports whether the request already carries this decision. A different decision, or a request
// that is no longer pending without one, is terminal.
func (d *admissionDecision) settled(ctx context.Context, live sqlc.SyncAdmissionRequest, operationName string) (bool, error) {
	if live.Status != "pending" {
		if (live.Status == "admitted" && d.input.Decision == publicinvites.DecisionApprove) || (live.Status == "denied" && d.input.Decision == publicinvites.DecisionDeny) {
			return true, nil
		}
		return false, publicinvites.ErrAdmissionRequestTerminal
	}
	if !live.DecisionExternalOperationID.Valid {
		return false, nil
	}
	name, err := d.queries.GetAdmissionDecisionOperationName(ctx, sqlc.GetAdmissionDecisionOperationNameParams{TenantID: live.TenantID, EpisodeID: live.EpisodeID, ExternalOperationID: live.DecisionExternalOperationID})
	if err != nil {
		return false, err
	}
	if name != operationName {
		return false, publicinvites.ErrAdmissionRequestTerminal
	}
	return true, nil
}

func (d *admissionDecision) record(ctx context.Context, rows decisionRows, operationName string) error {
	input, live := d.input, rows.live
	// Previous APIs lock the public request before the arrival when deciding.
	if _, err := d.queries.LockSpacePublicAdmissionRequest(ctx, sqlc.LockSpacePublicAdmissionRequestParams{TenantID: live.TenantID, SpaceID: live.SpaceID, RequestHandle: uuid(input.RequestHandle)}); err != nil {
		return err
	}
	currentArrival, err := d.queries.LockSpacePublicArrival(ctx, uuid(d.arrivalHandle))
	if err != nil {
		return err
	}
	valid, err := publicAdmissionProvenanceValid(rows.space, rows.invite, currentArrival, rows.episode, time.Now())
	if err != nil {
		return err
	}
	if !valid || !live.ExpiresAt.Time.After(time.Now()) {
		return publicinvites.ErrAdmissionRequestTerminal
	}
	payload, err := json.Marshal(struct {
		ID string `json:"admissionRequestId"`
	}{input.RequestHandle.String()})
	if err != nil {
		return err
	}
	key := input.RequestKey
	if key == "" {
		key = input.RequestHandle.String()
	}
	operation, err := createOrRetryAdmissionDecision(ctx, d.queries, d.tx, tenantExternalOperationInput{
		TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: utilities.IDFromBytes(live.EpisodeID.Bytes), OperationName: operationName,
		Request: episodes.Request{Key: key, Fingerprint: sha256.Sum256(payload)}, Payload: payload,
		JourneyName: "participant.public_admission_decided",
	})
	if err != nil {
		return err
	}
	reserved, err := d.queries.ReserveEpisodeAdmissionDecision(ctx, sqlc.ReserveEpisodeAdmissionDecisionParams{TenantID: live.TenantID, SpaceID: live.SpaceID, EpisodeID: live.EpisodeID, AdmissionRequestID: live.AdmissionRequestID, ExternalOperationID: operation.ExternalOperationID})
	if err != nil {
		return err
	}
	if reserved != 1 {
		return publicinvites.ErrAdmissionRequestTerminal
	}
	return d.queries.RecordPublicAdmissionDecision(ctx, sqlc.RecordPublicAdmissionDecisionParams{
		TenantID: live.TenantID, SpaceID: live.SpaceID, RequestHandle: uuid(input.RequestHandle),
		DecidedBy: uuid(input.ActorID), DecisionRequestKey: optionalText(key),
	})
}
