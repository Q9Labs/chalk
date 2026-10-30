package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/platform/httpcontract"
	"github.com/q9labs/chalk/platform/objectstorage"
	"github.com/q9labs/chalk/platform/utilities"
)

type RecordingObjectService interface {
	GetObject(ctx context.Context, key string) (objectstorage.ObjectReader, error)
}

type listTranscriptsRequest struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
	Page        pagination.PageRequest
}

type getTranscriptRequest struct {
	TenantID     utilities.ID
	TranscriptID utilities.ID
}

func decodeListTranscriptsRequest(r *http.Request) (listTranscriptsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listTranscriptsRequest{}, err
	}
	recordingID, err := optionalRecordingIDQuery(r)
	if err != nil {
		return listTranscriptsRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listTranscriptsRequest{}, paginationAPIError(err)
	}
	return listTranscriptsRequest{TenantID: tenantID, RecordingID: recordingID, Page: page}, nil
}

func decodeGetTranscriptRequest(r *http.Request) (getTranscriptRequest, error) {
	tenantID, transcriptID, err := tenantTranscriptIDsRequest(r)
	if err != nil {
		return getTranscriptRequest{}, err
	}
	return getTranscriptRequest{TenantID: tenantID, TranscriptID: transcriptID}, nil
}

func tenantTranscriptIDsRequest(r *http.Request) (utilities.ID, utilities.ID, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	transcriptID, err := transcriptIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	return tenantID, transcriptID, nil
}

func transcriptReadErrors(extra ...httpcontract.APIError) []httpcontract.APIError {
	return append([]httpcontract.APIError{
		apiErrorUnauthenticated,
		apiErrorForbidden,
		apiErrorServiceUnavailable,
		apiErrorInvalidTenantID,
		apiErrorInternal,
	}, extra...)
}

func transcriptWriteErrors(extra ...httpcontract.APIError) []httpcontract.APIError {
	return append([]httpcontract.APIError{
		apiErrorUnauthenticated,
		apiErrorForbidden,
		apiErrorServiceUnavailable,
		apiErrorInvalidTenantID,
		apiErrorInternal,
	}, extra...)
}
