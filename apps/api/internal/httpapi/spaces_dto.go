package httpapi

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type spaceRoleResponse struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Capabilities []string `json:"capabilities"`
}

type spaceResponse struct {
	TranscriptLanguage            *string                          `json:"transcript_language"`
	ID                            string                           `json:"id"`
	Name                          string                           `json:"name"`
	TenantID                      string                           `json:"tenant_id"`
	Slug                          string                           `json:"slug"`
	MediaPlane                    string                           `json:"media_plane"`
	MediaPlaneSetting             *string                          `json:"media_plane_setting"`
	EffectiveMediaPlane           *string                          `json:"effective_media_plane"`
	RecordingPolicy               artifactpolicy.RecordingMode     `json:"recording_policy"`
	TranscriptionPolicy           artifactpolicy.TranscriptionMode `json:"transcription_policy"`
	Metadata                      any                              `json:"metadata"`
	RecurringPolicy               any                              `json:"recurring_policy"`
	AdmissionPolicy               any                              `json:"admission_policy"`
	DefaultEpisodeDurationSeconds int32                            `json:"default_episode_duration_seconds"`
	MaximumEpisodeDurationSeconds int32                            `json:"maximum_episode_duration_seconds"`
	LingerWindowSeconds           int32                            `json:"linger_window_seconds"`
	ArchivedAt                    *string                          `json:"archived_at,omitempty"`
	Archived                      bool                             `json:"archived"`
	Roles                         []spaceRoleResponse              `json:"roles"`
	CreatedByUserID               *string                          `json:"created_by_user_id"`
	UpdatedAt                     string                           `json:"updated_at"`
	CreatedAt                     string                           `json:"created_at"`
}

type spaceListResponse struct {
	Spaces     []spaceResponse    `json:"spaces"`
	Pagination paginationResponse `json:"pagination"`
}

type createSpaceRequest struct {
	TranscriptLanguage            artifactpolicy.OptionalTranscriptLanguage `json:"transcript_language"`
	Name                          string                                    `json:"name"`
	Slug                          string                                    `json:"slug"`
	MediaPlane                    utilities.OptionalString                  `json:"media_plane"`
	Metadata                      utilities.OptionalJSON                    `json:"metadata"`
	RecurringPolicy               utilities.OptionalJSON                    `json:"recurring_policy"`
	AdmissionPolicy               utilities.OptionalJSON                    `json:"admission_policy"`
	DefaultEpisodeDurationSeconds int32                                     `json:"default_episode_duration_seconds"`
	MaximumEpisodeDurationSeconds int32                                     `json:"maximum_episode_duration_seconds"`
	LingerWindowSeconds           int32                                     `json:"linger_window_seconds"`
	RecordingPolicy               utilities.OptionalString                  `json:"recording_policy"`
	TranscriptionPolicy           utilities.OptionalString                  `json:"transcription_policy"`
}

type updateSpaceRequest struct {
	TranscriptLanguage            artifactpolicy.OptionalTranscriptLanguage `json:"transcript_language"`
	Name                          utilities.OptionalString                  `json:"name"`
	Slug                          utilities.OptionalString                  `json:"slug"`
	MediaPlane                    utilities.OptionalString                  `json:"media_plane"`
	Metadata                      utilities.OptionalJSON                    `json:"metadata"`
	RecurringPolicy               utilities.OptionalJSON                    `json:"recurring_policy"`
	AdmissionPolicy               utilities.OptionalJSON                    `json:"admission_policy"`
	DefaultEpisodeDurationSeconds spaces.OptionalInt32                      `json:"default_episode_duration_seconds"`
	MaximumEpisodeDurationSeconds spaces.OptionalInt32                      `json:"maximum_episode_duration_seconds"`
	LingerWindowSeconds           spaces.OptionalInt32                      `json:"linger_window_seconds"`
	RecordingPolicy               utilities.OptionalString                  `json:"recording_policy"`
	TranscriptionPolicy           utilities.OptionalString                  `json:"transcription_policy"`
}

type createSpaceEndpointRequest struct {
	TenantID   utilities.ID
	RequestKey string
	Body       createSpaceRequest
}

type listSpacesRequest struct {
	TenantID utilities.ID
	Page     pagination.PageRequest
	Archived *bool
}

type getSpaceRequest struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
}

type updateSpaceEndpointRequest struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	Body     updateSpaceRequest
}

func newSpaceListResponse(ctx context.Context, service SpaceService, tenantID utilities.ID, list spaces.SpaceList) (spaceListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return spaceListResponse{}, err
	}
	responses, err := newSpaceResponses(ctx, service, tenantID, list.Spaces)
	if err != nil {
		return spaceListResponse{}, err
	}
	return spaceListResponse{Spaces: responses, Pagination: page}, nil
}

func singleSpaceResponse(ctx context.Context, service SpaceService, tenantID utilities.ID, space spaces.Space) (spaceResponse, error) {
	responses, err := newSpaceResponses(ctx, service, tenantID, []spaces.Space{space})
	if err != nil {
		return spaceResponse{}, err
	}
	return responses[0], nil
}

func newSpaceResponses(ctx context.Context, service SpaceService, tenantID utilities.ID, list []spaces.Space) ([]spaceResponse, error) {
	effective := make([]*spaces.MediaPlaneProvider, len(list))
	if planes, ok := service.(SpacePlaneService); ok {
		var err error
		if effective, err = planes.EffectiveMediaPlanes(ctx, tenantID, list); err != nil {
			return nil, err
		}
	}
	responses := make([]spaceResponse, 0, len(list))
	for i, space := range list {
		response := newSpaceResponse(space)
		response.EffectiveMediaPlane = planeString(effective[i])
		responses = append(responses, response)
	}
	return responses, nil
}

func planeString(plane *spaces.MediaPlaneProvider) *string {
	if plane == nil {
		return nil
	}
	value := string(*plane)
	return &value
}

func newSpaceResponse(space spaces.Space) spaceResponse {
	roles := make([]spaceRoleResponse, 0, len(space.Roles))
	for _, role := range space.Roles {
		roles = append(roles, spaceRoleResponse{ID: role.ID.String(), Name: role.Name, Capabilities: append([]string{}, role.Capabilities...)})
	}
	return spaceResponse{
		ID:                            space.ID.String(),
		Name:                          space.Name,
		TenantID:                      space.TenantID.String(),
		Slug:                          space.Slug,
		MediaPlane:                    space.MediaPlane,
		MediaPlaneSetting:             planeString(space.MediaPlaneSetting),
		RecordingPolicy:               space.RecordingPolicy,
		TranscriptionPolicy:           space.TranscriptionPolicy,
		TranscriptLanguage:            transcriptLanguageString(space.TranscriptLanguage),
		Metadata:                      rawJSONValue(space.Metadata),
		RecurringPolicy:               rawJSONValue(space.RecurringPolicy),
		AdmissionPolicy:               rawJSONValue(space.AdmissionPolicy),
		DefaultEpisodeDurationSeconds: space.DefaultEpisodeDurationSeconds,
		MaximumEpisodeDurationSeconds: space.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds:           space.LingerWindowSeconds,
		ArchivedAt:                    optionalTimestampString(space.ArchivedAt),
		Archived:                      space.ArchivedAt != nil,
		Roles:                         roles,
		CreatedByUserID:               optionalIDString(space.CreatedByUserID),
		UpdatedAt:                     utilities.FormatTimestamp(space.UpdatedAt),
		CreatedAt:                     utilities.FormatTimestamp(space.CreatedAt),
	}
}

func transcriptLanguageString(mode *artifactpolicy.TranscriptLanguage) *string {
	if mode == nil {
		return nil
	}
	value := mode.String()
	return &value
}
