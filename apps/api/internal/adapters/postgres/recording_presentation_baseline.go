package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingPresentationBaselineQuerier interface {
	InsertRecordingPresentationBaseline(context.Context, sqlc.InsertRecordingPresentationBaselineParams) (sqlc.RecordingPresentationBaseline, error)
	GetRecordingPresentationBaseline(context.Context, sqlc.GetRecordingPresentationBaselineParams) (sqlc.RecordingPresentationBaseline, error)
}

func (r RecordingPipelineRepository) insertRecordingPresentationBaseline(ctx context.Context, queries recordingPipelineQuerier, input recordingpipeline.ReservationInput) error {
	if r.presentationProfile == nil {
		return nil
	}
	presentationQueries, ok := queries.(recordingPresentationBaselineQuerier)
	if !ok {
		return errors.New("recording pipeline query executor lacks presentation baseline authority")
	}
	profileBytes, err := json.Marshal(r.presentationProfile)
	if err != nil {
		return fmt.Errorf("marshal recording presentation profile: %w", err)
	}
	presentationHandle, err := utilities.NewID()
	if err != nil {
		return fmt.Errorf("generate recording presentation handle: %w", err)
	}
	params := sqlc.InsertRecordingPresentationBaselineParams{
		PresentationHandle: uuid(presentationHandle),
		ProfileVersion:     r.presentationProfile.Version,
		Profile:            profileBytes,
		BaselineAt:         timestamptzValue(r.now().UTC()),
		RecordingID:        uuid(input.RecordingID),
		TenantID:           uuid(input.TenantID),
		SpaceID:            uuid(input.SpaceID),
		EpisodeID:          uuid(input.EpisodeID),
	}
	if _, err := presentationQueries.InsertRecordingPresentationBaseline(ctx, params); err == nil {
		return nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("insert recording presentation baseline: %w", err)
	}
	existing, err := presentationQueries.GetRecordingPresentationBaseline(ctx, sqlc.GetRecordingPresentationBaselineParams{
		TenantID: params.TenantID, SpaceID: params.SpaceID,
		EpisodeID: params.EpisodeID, RecordingID: params.RecordingID,
	})
	if err != nil {
		return fmt.Errorf("get recording presentation baseline replay: %w", err)
	}
	if existing.ProfileVersion != r.presentationProfile.Version || !samePresentationProfile(existing.Profile, *r.presentationProfile) {
		return recordingpipeline.ErrReservationConflict
	}
	return nil
}

func samePresentationProfile(encoded []byte, expected recordingpresentation.Profile) bool {
	var actual recordingpresentation.Profile
	if err := json.Unmarshal(encoded, &actual); err != nil {
		return false
	}
	return reflect.DeepEqual(actual, expected)
}
