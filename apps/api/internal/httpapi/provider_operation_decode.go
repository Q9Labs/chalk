package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func decodeProviderOperationBody(w http.ResponseWriter, request *http.Request) (providerOperationRequest, error) {
	request.Body = http.MaxBytesReader(w, request.Body, providerOperationBodyLimit)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var body providerOperationRequest
	if err := decoder.Decode(&body); err != nil {
		return providerOperationRequest{}, errors.Join(provideroperations.ErrInvalidEffect, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return providerOperationRequest{}, errors.Join(
			provideroperations.ErrInvalidEffect,
			errors.New("provider operation body must contain one JSON value"),
		)
	}
	return body, nil
}

func providerOperationInput(operationID string, body providerOperationRequest) (provideroperations.OperationInput, error) {
	tenantID, err := utilities.ParseID(body.TenantID)
	if err != nil {
		return provideroperations.OperationInput{}, provideroperations.ErrInvalidTenantID
	}
	episodeID, err := utilities.ParseID(body.EpisodeID)
	if err != nil {
		return provideroperations.OperationInput{}, provideroperations.ErrInvalidEpisodeID
	}

	input := provideroperations.OperationInput{
		OperationID: operationID,
		Effect:      body.Effect,
		TenantID:    tenantID,
		EpisodeID:   episodeID,
	}
	if body.ParticipantID != nil {
		participantID, parseErr := utilities.ParseID(*body.ParticipantID)
		if parseErr != nil {
			return provideroperations.OperationInput{}, provideroperations.ErrInvalidParticipantID
		}
		input.ParticipantID = participantID
	}
	if body.ParticipantGeneration != nil {
		input.ParticipantGeneration = *body.ParticipantGeneration
	}
	if body.PublicationSource != nil {
		input.PublicationSource = *body.PublicationSource
	}
	if body.ControlRevision != nil {
		input.ControlRevision = *body.ControlRevision
	}
	if body.RecordingID != nil {
		recordingID, parseErr := utilities.ParseID(*body.RecordingID)
		if parseErr != nil {
			return provideroperations.OperationInput{}, provideroperations.ErrInvalidRecordingID
		}
		input.RecordingID = recordingID
	}
	if body.RecordingReservation != nil {
		spaceID, parseErr := utilities.ParseID(body.RecordingReservation.SpaceID)
		if parseErr != nil {
			return provideroperations.OperationInput{}, provideroperations.ErrInvalidRecordingReservation
		}
		input.RecordingReservation = &provideroperations.RecordingReservation{
			SpaceID:               spaceID,
			ParticipantCount:      body.RecordingReservation.ParticipantCount,
			MaxDurationSeconds:    body.RecordingReservation.MaxDurationSeconds,
			InputBitrateBPS:       body.RecordingReservation.InputBitrateBPS,
			PolicySnapshotVersion: body.RecordingReservation.PolicySnapshotVersion,
		}
	}
	_, err = input.Canonicalize()
	return input, err
}

func providerObservationQuery(request *http.Request) (utilities.ID, utilities.ID, *provideroperations.Cursor, int, error) {
	query := request.URL.Query()
	tenantID, err := utilities.ParseID(query.Get("tenant_id"))
	if err != nil {
		return utilities.ID{}, utilities.ID{}, nil, 0, provideroperations.ErrInvalidTenantID
	}
	episodeID, err := utilities.ParseID(query.Get("episode_id"))
	if err != nil {
		return utilities.ID{}, utilities.ID{}, nil, 0, provideroperations.ErrInvalidEpisodeID
	}

	limit := providerObservationLimit
	if value := query.Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 || limit > providerObservationLimit {
			return utilities.ID{}, utilities.ID{}, nil, 0, provideroperations.ErrInvalidObservationCursor
		}
	}

	afterIncarnation := query.Get("after_incarnation")
	afterSequence := query.Get("after_sequence")
	if afterIncarnation == "" && afterSequence == "" {
		return tenantID, episodeID, nil, limit, nil
	}
	if afterIncarnation == "" || afterSequence == "" {
		return utilities.ID{}, utilities.ID{}, nil, 0, provideroperations.ErrInvalidObservationCursor
	}
	incarnation, err := strconv.ParseInt(afterIncarnation, 10, 64)
	if err != nil || incarnation < 0 {
		return utilities.ID{}, utilities.ID{}, nil, 0, provideroperations.ErrInvalidObservationCursor
	}
	sequence, err := strconv.ParseInt(afterSequence, 10, 64)
	if err != nil || sequence < 0 {
		return utilities.ID{}, utilities.ID{}, nil, 0, provideroperations.ErrInvalidObservationCursor
	}
	return tenantID, episodeID, &provideroperations.Cursor{Incarnation: incarnation, Sequence: sequence}, limit, nil
}
