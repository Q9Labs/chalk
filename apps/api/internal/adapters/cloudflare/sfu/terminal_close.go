package sfu

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
)

func (a Adapter) closeSessionTerminated(ctx context.Context, providerSessionID string, closeErr error) bool {
	var closeFailure providerFailure
	if !errors.As(closeErr, &closeFailure) ||
		closeFailure.operation != "close_tracks" ||
		closeFailure.stage != failureStageTrack ||
		closeFailure.statusCode != http.StatusOK ||
		closeFailure.providerCode != "provider_internal" {
		return false
	}

	// An empty snapshot can miss an in-flight tracks/new allocation, and a 404 may be app-level or transient.
	path := fmt.Sprintf("/sessions/%s", url.PathEscape(providerSessionID))
	var response captureInspectResponse
	err := a.request(ctx, http.MethodGet, path, nil, &response, "verify_connection")
	var inspectionFailure providerFailure
	return errors.As(err, &inspectionFailure) &&
		inspectionFailure.operation == "verify_connection" &&
		inspectionFailure.stage == failureStageHTTPStatus &&
		inspectionFailure.statusCode == http.StatusGone &&
		inspectionFailure.details.rawCode == "session_error"
}
