package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/captureproviders"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

type recordingCaptureBindingQuerier interface {
	GetRecordingCaptureBinding(context.Context, sqlc.GetRecordingCaptureBindingParams) ([]byte, error)
}

// RecordingCaptureBindingSource resolves capture authority exclusively from
// the immutable Episode snapshot selected by the full Recording identity.
type RecordingCaptureBindingSource struct {
	queries recordingCaptureBindingQuerier
}

func NewRecordingCaptureBindingSource(queries recordingCaptureBindingQuerier) RecordingCaptureBindingSource {
	return RecordingCaptureBindingSource{queries: queries}
}

func (s RecordingCaptureBindingSource) ResolveBinding(ctx context.Context, identity captureplane.CaptureIdentity) (mediaplane.Binding, error) {
	if err := identity.Validate(); err != nil || s.queries == nil {
		return mediaplane.Binding{}, fmt.Errorf("%w: capture identity", mediaplane.ErrInvalidBinding)
	}

	snapshot, err := s.queries.GetRecordingCaptureBinding(ctx, sqlc.GetRecordingCaptureBindingParams{
		RecordingID: uuid(identity.RecordingID),
		TenantID:    uuid(identity.TenantID),
		SpaceID:     uuid(identity.SpaceID),
		EpisodeID:   uuid(identity.EpisodeID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return mediaplane.Binding{}, fmt.Errorf("%w: recording identity", mediaplane.ErrInvalidBinding)
	}
	if err != nil {
		return mediaplane.Binding{}, fmt.Errorf("read recording capture binding: %w", err)
	}

	var config struct {
		MediaPlaneBinding *mediaplane.Binding `json:"media_plane_binding"`
	}
	if len(snapshot) == 0 || json.Unmarshal(snapshot, &config) != nil || config.MediaPlaneBinding == nil {
		return mediaplane.Binding{}, fmt.Errorf("%w: Episode config snapshot", mediaplane.ErrInvalidBinding)
	}
	if err := config.MediaPlaneBinding.Validate(); err != nil {
		return mediaplane.Binding{}, fmt.Errorf("%w: Episode config snapshot", mediaplane.ErrInvalidBinding)
	}
	return *config.MediaPlaneBinding, nil
}

var _ captureproviders.BindingSource = RecordingCaptureBindingSource{}
