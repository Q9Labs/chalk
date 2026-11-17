package episodes

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// EndReason says why the API ended an Episode. It is the vocabulary of Sync's
// episode_ended event; an end that a participant asks for never passes here.
// An empty EndReason means EndReasonTenantRecovery.
type EndReason string

const (
	// EndReasonTenantRecovery is the default: the tenant's server ended the call.
	EndReasonTenantRecovery EndReason = "tenant_recovery"
	// EndReasonLingerExpired means everyone left and nobody came back in time.
	EndReasonLingerExpired EndReason = "linger_expired"
	// EndReasonMaximumDuration means the call reached its time limit.
	EndReasonMaximumDuration EndReason = "maximum_duration"
)

// payload is what the end request carries to Sync. The default reason is the
// empty payload, so a request made before reasons existed keeps its fingerprint.
func (r EndReason) payload() (json.RawMessage, error) {
	switch r {
	case "", EndReasonTenantRecovery:
		return json.RawMessage(`{}`), nil
	case EndReasonLingerExpired, EndReasonMaximumDuration:
		return json.RawMessage(`{"reason":"` + string(r) + `"}`), nil
	default:
		return nil, ErrInvalidIntentPayload
	}
}

func prepareEpisodeEndInput(input *RequestEpisodeEndInput) error {
	if err := validateTenantSpaceEpisodeIDs(input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
		return err
	}
	payload, err := input.Reason.payload()
	if err != nil {
		return err
	}
	if err := prepareRequest(&input.Request, payload); err != nil {
		return err
	}
	input.Request.Fingerprint = lifecycleFingerprint(struct {
		TenantID      string          `json:"tenant_id"`
		SpaceID       string          `json:"space_id"`
		EpisodeID     string          `json:"episode_id"`
		OperationName string          `json:"operation_name"`
		Payload       json.RawMessage `json:"payload"`
	}{
		TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(), EpisodeID: input.EpisodeID.String(),
		OperationName: OperationTenantEndEpisode, Payload: payload,
	})
	return nil
}

func prepareSetDeadlineInput(input *SetDeadlineInput) error {
	if err := validateTenantSpaceEpisodeIDs(input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
		return err
	}
	if input.Deadline.IsZero() {
		return ErrInvalidDeadline
	}
	input.Deadline = input.Deadline.UTC().Truncate(time.Millisecond)
	if err := prepareRequest(&input.Request, json.RawMessage(`{}`)); err != nil {
		return err
	}
	input.Request.Fingerprint = lifecycleFingerprint(struct {
		TenantID      string `json:"tenant_id"`
		SpaceID       string `json:"space_id"`
		EpisodeID     string `json:"episode_id"`
		OperationName string `json:"operation_name"`
		DeadlineAtMS  int64  `json:"deadline_at_ms"`
	}{
		TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(), EpisodeID: input.EpisodeID.String(),
		OperationName: OperationTenantSetDeadline, DeadlineAtMS: input.Deadline.UnixMilli(),
	})
	return nil
}

// NewLingerRequest keys the end of one empty window. Each failed earlier end
// of that window adds a retry suffix, so a retry is a new operation.
func NewLingerRequest(tenantID, spaceID, episodeID utilities.ID, lastDepartureAt time.Time, failedAttempts int) (Request, error) {
	key := "empty-episode-linger-" + strconv.FormatInt(lastDepartureAt.UnixMicro(), 10)
	if failedAttempts > 0 {
		key += "-retry-" + strconv.Itoa(failedAttempts)
	}
	input := RequestEpisodeEndInput{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, Reason: EndReasonLingerExpired, Request: Request{Key: key}}
	if err := prepareEpisodeEndInput(&input); err != nil {
		return Request{}, err
	}
	return input.Request, nil
}
