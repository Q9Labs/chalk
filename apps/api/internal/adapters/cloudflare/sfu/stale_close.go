package sfu

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func (a Adapter) internalCloseSessionGone(ctx context.Context, input mediaplane.CloseTracksRequest, closeErr error) bool {
	var failure providerFailure
	if !errors.As(closeErr, &failure) || failure.operation != "close_tracks" ||
		failure.stage != failureStageTrack || failure.statusCode != http.StatusOK ||
		failure.providerCode != "provider_internal" {
		return false
	}

	// Only a missing session proves terminal absence. Empty or inactive track
	// snapshots are not enough: an outstanding tracks/new can still finish,
	// including after the caller's HTTP timeout.
	var response captureInspectResponse
	err := a.request(ctx, http.MethodGet, fmt.Sprintf("/sessions/%s", url.PathEscape(input.ConnectionID)), nil, &response, "verify_connection")
	return errors.As(err, &failure) && (failure.statusCode == http.StatusNotFound || failure.statusCode == http.StatusGone)
}
