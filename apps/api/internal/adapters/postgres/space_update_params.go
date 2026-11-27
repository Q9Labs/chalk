package postgres

import (
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// updateTenantSpaceParams is the one place a Space update maps to its query, for the plain write and the one that produces a webhook.
func updateTenantSpaceParams(tenantID, spaceID utilities.ID, input spaces.UpdateSpaceInput) sqlc.UpdateTenantSpaceParams {
	return sqlc.UpdateTenantSpaceParams{
		TenantID:                         uuid(tenantID),
		ID:                               uuid(spaceID),
		NameSet:                          input.Name.Set,
		Name:                             requiredText(input.Name),
		SlugSet:                          input.Slug.Set,
		Slug:                             requiredText(input.Slug),
		MediaPlaneSet:                    input.MediaPlane.Set,
		MediaPlane:                       requiredText(input.MediaPlane),
		MediaPlaneSettingSet:             input.MediaPlaneSetting.Set,
		MediaPlaneSetting:                optionalPlaneSetting(input.MediaPlaneSetting),
		MetadataSet:                      input.Metadata.Set,
		Metadata:                         jsonBytes(input.Metadata.Value),
		RecurringPolicySet:               input.RecurringPolicy.Set,
		RecurringPolicy:                  jsonBytes(input.RecurringPolicy.Value),
		AdmissionPolicySet:               input.AdmissionPolicy.Set,
		AdmissionPolicy:                  jsonBytes(input.AdmissionPolicy.Value),
		DefaultEpisodeDurationSecondsSet: input.DefaultEpisodeDurationSeconds.Set,
		DefaultEpisodeDurationSeconds:    optionalInt32(input.DefaultEpisodeDurationSeconds),
		MaximumEpisodeDurationSecondsSet: input.MaximumEpisodeDurationSeconds.Set,
		MaximumEpisodeDurationSeconds:    optionalInt32(input.MaximumEpisodeDurationSeconds),
		LingerWindowSecondsSet:           input.LingerWindowSeconds.Set,
		LingerWindowSeconds:              optionalInt32(input.LingerWindowSeconds),
		RecordingPolicySet:               input.RecordingPolicy.Set,
		RecordingPolicy:                  optionalRecordingPolicy(input.RecordingPolicy),
		TranscriptionPolicySet:           input.TranscriptionPolicy.Set,
		TranscriptLanguageSet:            input.TranscriptLanguage.Set,
		TranscriptLanguage:               text(optionalLanguageString(input.TranscriptLanguage.Value)),
		FocusSet:                         input.Focus.Set,
		Focus:                            optionalFocusJSON(input.Focus),
		TranscriptionPolicy:              optionalTranscriptionPolicy(input.TranscriptionPolicy),
	}
}
