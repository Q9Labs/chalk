package postgres

import (
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func createSpaceParams(input spaces.CreateSpaceInput) sqlc.CreateSpaceParams {
	return sqlc.CreateSpaceParams{
		ID:                            uuid(input.ID),
		PublicInviteHandle:            append([]byte(nil), input.PublicInviteHandle[:]...),
		Name:                          input.Name,
		TenantID:                      uuid(input.TenantID),
		Slug:                          input.Slug,
		MediaPlane:                    input.MediaPlane,
		MediaPlaneSetting:             optionalPlaneSetting(spaces.OptionalMediaPlaneSetting{Set: true, Value: input.MediaPlaneSetting}),
		Metadata:                      jsonBytes(input.Metadata),
		RecurringPolicy:               jsonBytes(input.RecurringPolicy),
		AdmissionPolicy:               jsonBytes(input.AdmissionPolicy),
		RecordingPolicy:               policyText(string(input.RecordingPolicy), input.RecordingPolicySet),
		TranscriptionPolicy:           policyText(string(input.TranscriptionPolicy), input.TranscriptionPolicySet),
		TranscriptLanguage:            text(optionalLanguageString(input.TranscriptLanguage)),
		DefaultEpisodeDurationSeconds: input.DefaultEpisodeDurationSeconds,
		MaximumEpisodeDurationSeconds: input.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds:           input.LingerWindowSeconds,
		CreatedByUserID:               uuid(input.CreatedByUserID),
	}
}

func listTenantSpacesParams(tenantID utilities.ID, page pagination.PageRequest, archived *bool) sqlc.ListTenantSpacesParams {
	cursor := page.Cursor()
	params := sqlc.ListTenantSpacesParams{
		TenantID: uuid(tenantID),
		PageSize: int32(page.Size() + 1),
	}
	if archived != nil {
		params.ArchivedSet = true
		params.Archived = *archived
	}
	if cursor == nil {
		return params
	}

	params.CursorSet = true
	params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
	params.CursorID = uuid(cursor.ID)
	return params
}

func optionalInt32(value spaces.OptionalInt32) int32 {
	if value.Value == nil {
		return 0
	}
	return *value.Value
}

func optionalRecordingPolicy(value spaces.OptionalRecordingPolicy) string {
	if !value.Set || value.Value == nil {
		return ""
	}
	return string(*value.Value)
}

func optionalTranscriptionPolicy(value spaces.OptionalTranscriptionPolicy) string {
	if !value.Set || value.Value == nil {
		return ""
	}
	return string(*value.Value)
}

func policyText(value string, set bool) pgtype.Text {
	if !set {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}

func mapSpace(space sqlc.Space) spaces.Space {
	return spaces.Space{
		ID:                            utilities.IDFromBytes(space.ID.Bytes),
		Name:                          space.Name,
		TenantID:                      utilities.IDFromBytes(space.TenantID.Bytes),
		Slug:                          space.Slug,
		MediaPlane:                    space.MediaPlane,
		MediaPlaneSetting:             mediaPlaneSetting(space.MediaPlaneSetting),
		RecordingPolicy:               artifactpolicy.RecordingMode(space.RecordingPolicy),
		TranscriptionPolicy:           artifactpolicy.TranscriptionMode(space.TranscriptionPolicy),
		TranscriptLanguage:            nullableTranscriptLanguage(space.TranscriptLanguage),
		Metadata:                      jsonRaw(space.Metadata),
		RecurringPolicy:               jsonRaw(space.RecurringPolicy),
		AdmissionPolicy:               jsonRaw(space.AdmissionPolicy),
		DefaultEpisodeDurationSeconds: space.DefaultEpisodeDurationSeconds,
		MaximumEpisodeDurationSeconds: space.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds:           space.LingerWindowSeconds,
		ArchivedAt:                    nullableTimestamp(space.ArchivedAt),
		CreatedByUserID:               nullableID(space.CreatedByUserID),
		UpdatedAt:                     timestamp(space.UpdatedAt),
		CreatedAt:                     timestamp(space.CreatedAt),
	}
}

func mapCreatedSpace(space sqlc.CreateSpaceRow) spaces.Space {
	return spaces.Space{
		ID:                            utilities.IDFromBytes(space.ID.Bytes),
		Name:                          space.Name,
		TenantID:                      utilities.IDFromBytes(space.TenantID.Bytes),
		Slug:                          space.Slug,
		MediaPlane:                    space.MediaPlane,
		MediaPlaneSetting:             mediaPlaneSetting(space.MediaPlaneSetting),
		RecordingPolicy:               artifactpolicy.RecordingMode(space.RecordingPolicy),
		TranscriptionPolicy:           artifactpolicy.TranscriptionMode(space.TranscriptionPolicy),
		TranscriptLanguage:            nullableTranscriptLanguage(space.TranscriptLanguage),
		Metadata:                      jsonRaw(space.Metadata),
		RecurringPolicy:               jsonRaw(space.RecurringPolicy),
		AdmissionPolicy:               jsonRaw(space.AdmissionPolicy),
		DefaultEpisodeDurationSeconds: space.DefaultEpisodeDurationSeconds,
		MaximumEpisodeDurationSeconds: space.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds:           space.LingerWindowSeconds,
		ArchivedAt:                    nullableTimestamp(space.ArchivedAt),
		CreatedByUserID:               nullableID(space.CreatedByUserID),
		UpdatedAt:                     timestamp(space.UpdatedAt),
		CreatedAt:                     timestamp(space.CreatedAt),
	}
}

func mapSpaceRole(role sqlc.SpaceRole) spaces.Role {
	return spaces.Role{
		ID:           utilities.IDFromBytes(role.ID.Bytes),
		TenantID:     utilities.IDFromBytes(role.TenantID.Bytes),
		SpaceID:      utilities.IDFromBytes(role.SpaceID.Bytes),
		Name:         role.Name,
		Capabilities: append([]string(nil), role.Capabilities...),
	}
}

func mediaPlaneSetting(value pgtype.Text) *spaces.MediaPlaneProvider {
	if !value.Valid {
		return nil
	}
	provider := spaces.MediaPlaneProvider(value.String)
	return &provider
}

func optionalPlaneSetting(input spaces.OptionalMediaPlaneSetting) pgtype.Text {
	if !input.Set || input.Value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: string(*input.Value), Valid: true}
}
