package httpapi

import (
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func decodeRequestRecordingExportEndpointRequest(r *http.Request) (requestRecordingExportEndpointRequest, error) {
	tenantID, recordingID, err := tenantRecordingIDsRequest(r)
	if err != nil {
		return requestRecordingExportEndpointRequest{}, err
	}
	if _, err := decodeJSONBody[struct{}](r); err != nil {
		return requestRecordingExportEndpointRequest{}, err
	}
	return requestRecordingExportEndpointRequest{TenantID: tenantID, RecordingID: recordingID}, nil
}

func decodeListRecordingsRequest(r *http.Request) (listRecordingsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listRecordingsRequest{}, err
	}
	episodeID, err := optionalEpisodeIDQuery(r)
	if err != nil {
		return listRecordingsRequest{}, err
	}
	spaceID, err := optionalSpaceIDQuery(r)
	if err != nil {
		return listRecordingsRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listRecordingsRequest{}, paginationAPIError(err)
	}
	return listRecordingsRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, Page: page}, nil
}

func decodeGetRecordingRequest(r *http.Request) (getRecordingRequest, error) {
	tenantID, recordingID, err := tenantRecordingIDsRequest(r)
	if err != nil {
		return getRecordingRequest{}, err
	}
	return getRecordingRequest{TenantID: tenantID, RecordingID: recordingID}, nil
}

func decodeCreateRecordingDownloadURLRequest(r *http.Request) (createRecordingDownloadURLEndpointRequest, error) {
	tenantID, recordingID, err := tenantRecordingIDsRequest(r)
	if err != nil {
		return createRecordingDownloadURLEndpointRequest{}, err
	}
	body, err := decodeJSONBody[createRecordingDownloadURLRequest](r)
	if err != nil {
		return createRecordingDownloadURLEndpointRequest{}, err
	}
	return createRecordingDownloadURLEndpointRequest{TenantID: tenantID, RecordingID: recordingID, Body: body}, nil
}

func tenantRecordingIDsRequest(r *http.Request) (utilities.ID, utilities.ID, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	recordingID, err := recordingIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	return tenantID, recordingID, nil
}
