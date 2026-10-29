package sfu

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func (a Adapter) internalCloseTracksAbsent(ctx context.Context, input mediaplane.CloseTracksRequest, closeErr error) bool {
	var failure providerFailure
	if !errors.As(closeErr, &failure) || failure.providerCode != "provider_internal" {
		return false
	}

	// A retained MID can outlive the SFU track. Internal errors alone do not
	// prove cleanup: read the same session before retiring Chalk's reference.
	var response captureInspectResponse
	err := a.request(ctx, http.MethodGet, fmt.Sprintf("/sessions/%s", url.PathEscape(input.ConnectionID)), nil, &response, "verify_connection")
	if err != nil {
		return errors.As(err, &failure) && (failure.statusCode == http.StatusNotFound || failure.statusCode == http.StatusGone)
	}
	if response.Tracks == nil {
		return false
	}

	states := make(map[string]string, len(response.Tracks))
	for _, track := range response.Tracks {
		if track.Mid == "" || strings.TrimSpace(track.Mid) != track.Mid || track.ErrorCode != "" || track.ErrorDescription != "" {
			return false
		}
		if _, duplicate := states[track.Mid]; duplicate {
			return false
		}
		switch track.Status {
		case "active", "inactive", "waiting":
			states[track.Mid] = track.Status
		default:
			return false
		}
	}
	for _, track := range input.Tracks {
		if state, present := states[track.Mid]; present && state != "inactive" {
			return false
		}
	}
	return true
}
