package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func decodeCreateSpaceRequest(r *http.Request) (createSpaceEndpointRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return createSpaceEndpointRequest{}, err
	}
	body, err := decodeJSONBody[createSpaceRequest](r)
	if err != nil {
		return createSpaceEndpointRequest{}, err
	}
	requestKey := r.Header.Get(idempotencyKeyHeader)
	if strings.TrimSpace(requestKey) == "" {
		return createSpaceEndpointRequest{}, apiErrorInvalidRequestKey
	}
	return createSpaceEndpointRequest{TenantID: tenantID, RequestKey: requestKey, Body: body}, nil
}

func decodeListSpacesRequest(r *http.Request) (listSpacesRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listSpacesRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listSpacesRequest{}, paginationAPIError(err)
	}
	archived, err := optionalArchivedQuery(r)
	if err != nil {
		return listSpacesRequest{}, err
	}
	return listSpacesRequest{TenantID: tenantID, Page: page, Archived: archived}, nil
}

func optionalArchivedQuery(r *http.Request) (*bool, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("archived"))
	if raw == "" {
		return nil, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return nil, apiErrorInvalidSpaceArchiveFilter
	}
	return &value, nil
}

func decodeGetSpaceRequest(r *http.Request) (getSpaceRequest, error) {
	tenantID, spaceID, err := tenantSpaceIDsRequest(r)
	if err != nil {
		return getSpaceRequest{}, err
	}
	return getSpaceRequest{TenantID: tenantID, SpaceID: spaceID}, nil
}

func decodeUpdateSpaceRequest(r *http.Request) (updateSpaceEndpointRequest, error) {
	tenantID, spaceID, err := tenantSpaceIDsRequest(r)
	if err != nil {
		return updateSpaceEndpointRequest{}, err
	}
	body, err := decodeJSONBody[updateSpaceRequest](r)
	if err != nil {
		return updateSpaceEndpointRequest{}, err
	}
	return updateSpaceEndpointRequest{TenantID: tenantID, SpaceID: spaceID, Body: body}, nil
}

func tenantSpaceIDsRequest(r *http.Request) (utilities.ID, utilities.ID, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	spaceID, err := spaceIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	return tenantID, spaceID, nil
}

func (request createSpaceRequest) toCreateInput(tenantID utilities.ID, userID utilities.ID, requestKey string) (spaces.CreateSpaceInput, error) {
	mediaPlane := ""
	if request.MediaPlane.Value != nil {
		mediaPlane = *request.MediaPlane.Value
	}
	recordingPolicy, recordingPolicySet, err := parseRecordingPolicy(request.RecordingPolicy)
	if err != nil {
		return spaces.CreateSpaceInput{}, err
	}
	transcriptionPolicy, transcriptionPolicySet, err := parseTranscriptionPolicy(request.TranscriptionPolicy)
	if err != nil {
		return spaces.CreateSpaceInput{}, err
	}
	var recordingPolicyValue artifactpolicy.RecordingMode
	if recordingPolicy != nil {
		recordingPolicyValue = *recordingPolicy
	}
	var transcriptionPolicyValue artifactpolicy.TranscriptionMode
	if transcriptionPolicy != nil {
		transcriptionPolicyValue = *transcriptionPolicy
	}
	return spaces.CreateSpaceInput{
		Name:                          request.Name,
		TenantID:                      tenantID,
		Slug:                          request.Slug,
		MediaPlane:                    mediaPlane,
		MediaPlaneSet:                 request.MediaPlane.Set,
		Metadata:                      request.Metadata.Value,
		RecurringPolicy:               request.RecurringPolicy.Value,
		AdmissionPolicy:               request.AdmissionPolicy.Value,
		DefaultEpisodeDurationSeconds: request.DefaultEpisodeDurationSeconds,
		MaximumEpisodeDurationSeconds: request.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds:           request.LingerWindowSeconds,
		RecordingPolicy:               recordingPolicyValue,
		RecordingPolicySet:            recordingPolicySet,
		TranscriptionPolicy:           transcriptionPolicyValue,
		TranscriptLanguage:            request.TranscriptLanguage.Value,
		TranscriptionPolicySet:        transcriptionPolicySet,
		CreatedByUserID:               userID,
		RequestKey:                    requestKey,
	}, nil
}

func (request updateSpaceRequest) toUpdateInput() (spaces.UpdateSpaceInput, error) {
	recordingPolicy, recordingPolicySet, err := parseRecordingPolicy(request.RecordingPolicy)
	if err != nil {
		return spaces.UpdateSpaceInput{}, err
	}
	transcriptionPolicy, transcriptionPolicySet, err := parseTranscriptionPolicy(request.TranscriptionPolicy)
	if err != nil {
		return spaces.UpdateSpaceInput{}, err
	}
	return spaces.UpdateSpaceInput{
		Name:                          request.Name,
		Slug:                          request.Slug,
		MediaPlane:                    request.MediaPlane,
		Metadata:                      request.Metadata,
		RecurringPolicy:               request.RecurringPolicy,
		AdmissionPolicy:               request.AdmissionPolicy,
		DefaultEpisodeDurationSeconds: request.DefaultEpisodeDurationSeconds,
		MaximumEpisodeDurationSeconds: request.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds:           request.LingerWindowSeconds,
		RecordingPolicy:               spaces.OptionalRecordingPolicy{Set: recordingPolicySet, Value: recordingPolicy},
		TranscriptionPolicy:           spaces.OptionalTranscriptionPolicy{Set: transcriptionPolicySet, Value: transcriptionPolicy},
		TranscriptLanguage:            request.TranscriptLanguage,
	}, nil
}

func parseRecordingPolicy(value utilities.OptionalString) (*artifactpolicy.RecordingMode, bool, error) {
	if !value.Set {
		return nil, false, nil
	}
	if value.Value == nil {
		return nil, true, spaces.ErrInvalidRecordingPolicy
	}
	mode := artifactpolicy.RecordingMode(strings.TrimSpace(*value.Value))
	if err := mode.Validate(); err != nil {
		return nil, true, spaces.ErrInvalidRecordingPolicy
	}
	return &mode, true, nil
}

func parseTranscriptionPolicy(value utilities.OptionalString) (*artifactpolicy.TranscriptionMode, bool, error) {
	if !value.Set {
		return nil, false, nil
	}
	if value.Value == nil {
		return nil, true, spaces.ErrInvalidTranscriptionPolicy
	}
	mode := artifactpolicy.TranscriptionMode(strings.TrimSpace(*value.Value))
	if err := mode.Validate(); err != nil {
		return nil, true, spaces.ErrInvalidTranscriptionPolicy
	}
	return &mode, true, nil
}

func createdByUserID(ctx context.Context) utilities.ID {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok || principal.Kind != authentication.PrincipalUser {
		return utilities.ID{}
	}
	return principal.UserID
}
