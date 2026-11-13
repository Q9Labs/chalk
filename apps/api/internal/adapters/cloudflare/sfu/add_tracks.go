package sfu

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

func (a Adapter) AddTracks(ctx context.Context, input mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	// Cloudflare answers a call on a dropped session only after about 5 s, so a connection that is likely
	// expired gets a fresh session before the call. A failed creation falls through to the 410 path below.
	session, swapped, release, err := a.sessions.claim(ctx, input.ConnectionID, a.createConnection)
	if err != nil {
		return mediaplane.TracksResponse{}, fmt.Errorf("choose the Cloudflare session for connection %s: %w", input.ConnectionID, err)
	}
	defer release()
	if swapped {
		sfuSessionReplacements.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", "proactive")))
	}
	result, attempt, err := a.addTracks(ctx, input, session)
	retry := addTracksRetryNone
	if errors.Is(err, mediaplane.ErrConnectionNotFound) {
		fresh, replaced, replaceErr := a.sessions.replace(ctx, input.ConnectionID, session, a.createConnection)
		switch {
		case replaceErr != nil:
			sfuSessionReplacements.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", "failed")))
			// The record keeps the gone session's own status; the failed creation logs its own provider failure.
			logAddTracksCall(ctx, input, result.TrackErrors, attempt, err, addTracksRetryNone, false)
			return a.toClientIDs(result), a.errorWithClientIDs(replaceErr)
		case replaced:
			firstResult, first, firstErr := result, attempt, err
			result, attempt, err = a.addTracks(ctx, input, fresh)
			outcome := "failed"
			if err == nil {
				outcome = "recovered"
			}
			sfuSessionReplacements.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", outcome)))
			logAddTracksCall(ctx, input, firstResult.TrackErrors, first, firstErr, addTracksRetrySessionReplaced, err == nil)
			retry = addTracksRetryAfterSessionReplaced
		}
	}
	// A partial pull that carries an answer is accepted by the HTTP layer and negotiates the session.
	if err == nil || (mediaplane.IsPartialRemoteTrackResponse(err) && result.SessionDescription != nil) {
		a.sessions.negotiated(input.ConnectionID)
	}
	logAddTracksCall(ctx, input, result.TrackErrors, attempt, err, retry, false)
	return a.toClientIDs(result), a.errorWithClientIDs(err)
}

func (a Adapter) addTracks(ctx context.Context, input mediaplane.TracksRequest, session string) (mediaplane.TracksResponse, addTracksAttempt, error) {
	tracks := make([]providerTrack, 0, len(input.Tracks))
	localTracks := make([]providerTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		providerTrack := providerTrack{Location: track.Location, Mid: track.Mid, TrackName: track.TrackName, SessionID: a.sessions.providerID(track.SessionID), Simulcast: track.Simulcast}
		tracks = append(tracks, providerTrack)
		if track.Location == "local" {
			localTracks = append(localTracks, providerTrack)
		}
	}
	request := tracksRequest{
		SessionDescription: input.SessionDescription,
		Tracks:             tracks,
	}
	response := addTracksResponse{requestedTracks: tracks, requestedLocalTracks: localTracks}
	ageMs, negotiated := a.sessions.sessionContext(input.ConnectionID, session)
	started := time.Now()
	statusCode, err := a.requestStatus(ctx, http.MethodPost, fmt.Sprintf("/sessions/%s/tracks/new", url.PathEscape(session)), request, &response, "add_tracks")
	return response.toMediaPlane(), addTracksAttempt{latency: time.Since(started), statusCode: statusCode, sessionAgeMs: ageMs, sessionNegotiated: negotiated}, err
}

func (r *addTracksResponse) providerError(operation string, statusCode int) error {
	if strings.TrimSpace(r.ErrorCode) != "" || strings.TrimSpace(r.ErrorDescription) != "" {
		return newProviderResponseFailure(operation, failureStageTopLevel, statusCode, r.ErrorCode, r.ErrorDescription, len(r.Tracks), failedAddTrackCount(r.Tracks))
	}

	tracks := r.normalizedTracks()
	partialRemoteTracks := r.partialRemoteTrackResponse(tracks)
	exactRemoteAbsence := partialRemoteTracks && exactRemoteTrackAbsenceBatch(tracks)

	type localTrackIdentity struct {
		mid       string
		trackName string
	}
	requested := make(map[localTrackIdentity]struct{}, len(r.requestedLocalTracks))
	for _, track := range r.requestedLocalTracks {
		requested[localTrackIdentity{mid: track.Mid, trackName: track.TrackName}] = struct{}{}
	}

	seen := make(map[localTrackIdentity]struct{}, len(requested))
	for _, track := range tracks {
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			failure := newProviderResponseFailure(operation, failureStageTrack, statusCode, track.ErrorCode, track.ErrorDescription, len(r.Tracks), failedAddTrackCount(r.Tracks))
			if exactRemoteAbsence {
				failure.exactRemoteAbsence = true
				failure.missingRemoteTracks = missingRemoteTrackIdentities(tracks)
			}
			failure.partialRemoteTracks = partialRemoteTracks
			return failure
		}
		if track.SessionID != "" || track.Location == "remote" {
			continue
		}

		identity := localTrackIdentity{mid: track.Mid, trackName: track.TrackName}
		if _, ok := requested[identity]; !ok || track.Mid == "" || track.TrackName == "" {
			return newProviderFailure(operation, failureStageContract, statusCode, "invalid_contract")
		}
		if _, duplicate := seen[identity]; duplicate {
			return newProviderFailure(operation, failureStageContract, statusCode, "invalid_contract")
		}
		seen[identity] = struct{}{}
	}
	if len(seen) != len(requested) {
		return newProviderFailure(operation, failureStageContract, statusCode, "invalid_contract")
	}

	return nil
}

func (r addTracksResponse) partialRemoteTrackResponse(tracks []addTrackResult) bool {
	if len(r.requestedTracks) == 0 || len(r.requestedLocalTracks) != 0 {
		return false
	}

	requested := make(map[mediaplane.RemoteTrackIdentity]struct{}, len(r.requestedTracks))
	for _, track := range r.requestedTracks {
		identity := mediaplane.RemoteTrackIdentity{ConnectionID: strings.TrimSpace(track.SessionID), TrackName: strings.TrimSpace(track.TrackName)}
		if strings.TrimSpace(track.Location) != "remote" || identity.ConnectionID == "" || identity.TrackName == "" {
			return false
		}
		if _, duplicate := requested[identity]; duplicate {
			return false
		}
		requested[identity] = struct{}{}
	}

	failed := 0
	seen := make(map[mediaplane.RemoteTrackIdentity]struct{}, len(tracks))
	for _, track := range tracks {
		identity := mediaplane.RemoteTrackIdentity{ConnectionID: strings.TrimSpace(track.SessionID), TrackName: strings.TrimSpace(track.TrackName)}
		if strings.TrimSpace(track.Location) != "remote" || identity.ConnectionID == "" || identity.TrackName == "" {
			return false
		}
		if _, requestedHere := requested[identity]; !requestedHere {
			return false
		}
		if _, duplicate := seen[identity]; duplicate {
			return false
		}
		seen[identity] = struct{}{}
		if addTrackResultFailed(track) {
			if !transientRemoteTrackFailure(track) {
				return false
			}
			failed++
		}
	}
	return failed > 0
}

func transientRemoteTrackFailure(track addTrackResult) bool {
	switch normalizedProviderCode(providerRejectionCode(track.ErrorCode, track.ErrorDescription)) {
	case "track_not_found", "empty_track_error", "provider_internal", "timeout", "unknown":
		return true
	case "provider_rejected":
		return strings.Contains(strings.ToLower(track.ErrorDescription), "internal")
	default:
		return false
	}
}

func (r addTracksResponse) toMediaPlane() mediaplane.TracksResponse {
	providerTracks := r.normalizedTracks()
	tracks := make([]mediaplane.Track, 0, len(providerTracks))
	trackErrors := make([]mediaplane.TrackError, 0)
	for _, track := range providerTracks {
		if addTrackResultFailed(track) {
			code := normalizedProviderCode(providerRejectionCode(track.ErrorCode, track.ErrorDescription))
			publicationMissing := strings.EqualFold(strings.TrimSpace(track.ErrorCode), "not_found_track_error") || code == "track_not_found"
			trackErrors = append(trackErrors, mediaplane.TrackError{
				ConnectionID: track.SessionID, TrackName: track.TrackName, Code: code, PublicationMissing: publicationMissing,
			})
			continue
		}
		tracks = append(tracks, mediaplane.Track{
			Location:  track.Location,
			Mid:       track.Mid,
			TrackName: track.TrackName,
			SessionID: track.SessionID,
		})
	}

	return mediaplane.TracksResponse{
		SessionDescription:             r.SessionDescription,
		Tracks:                         tracks,
		TrackErrors:                    trackErrors,
		RequiresImmediateRenegotiation: r.RequiresImmediateRenegotiation,
	}
}

func (r addTracksResponse) normalizedTracks() []addTrackResult {
	requestedRemote := make(map[mediaplane.RemoteTrackIdentity]struct{}, len(r.requestedTracks))
	for _, track := range r.requestedTracks {
		if strings.TrimSpace(track.Location) != "remote" {
			continue
		}
		identity := mediaplane.RemoteTrackIdentity{ConnectionID: strings.TrimSpace(track.SessionID), TrackName: strings.TrimSpace(track.TrackName)}
		if identity.ConnectionID != "" && identity.TrackName != "" {
			requestedRemote[identity] = struct{}{}
		}
	}

	tracks := make([]addTrackResult, 0, len(r.Tracks))
	for _, track := range r.Tracks {
		track.Location = strings.TrimSpace(track.Location)
		track.SessionID = strings.TrimSpace(track.SessionID)
		track.TrackName = strings.TrimSpace(track.TrackName)
		identity := mediaplane.RemoteTrackIdentity{ConnectionID: track.SessionID, TrackName: track.TrackName}
		if track.Location == "" {
			if _, requested := requestedRemote[identity]; requested {
				track.Location = "remote"
			}
		}
		tracks = append(tracks, track)
	}
	return tracks
}

func addTrackResultFailed(track addTrackResult) bool {
	return strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != ""
}

func failedAddTrackCount(tracks []addTrackResult) int {
	count := 0
	for _, track := range tracks {
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			count++
		}
	}
	return count
}

func missingRemoteTrackIdentities(tracks []addTrackResult) []mediaplane.RemoteTrackIdentity {
	identities := make([]mediaplane.RemoteTrackIdentity, 0, len(tracks))
	seen := make(map[mediaplane.RemoteTrackIdentity]struct{}, len(tracks))
	for _, track := range tracks {
		if strings.TrimSpace(track.Location) != "remote" || !addTrackResultFailed(track) {
			continue
		}
		if normalizedProviderCode(providerRejectionCode(track.ErrorCode, track.ErrorDescription)) != "track_not_found" {
			continue
		}

		connectionID := strings.TrimSpace(track.SessionID)
		trackName := strings.TrimSpace(track.TrackName)
		if connectionID == "" || trackName == "" {
			continue
		}

		identity := mediaplane.RemoteTrackIdentity{ConnectionID: connectionID, TrackName: trackName}
		if _, exists := seen[identity]; exists {
			continue
		}
		seen[identity] = struct{}{}
		identities = append(identities, identity)
	}
	if len(identities) == 0 {
		return nil
	}
	return identities
}

func exactRemoteTrackAbsenceBatch(tracks []addTrackResult) bool {
	failed := 0
	for _, track := range tracks {
		if !addTrackResultFailed(track) {
			continue
		}
		failed++
		if strings.TrimSpace(track.Location) != "remote" || strings.TrimSpace(track.SessionID) == "" || strings.TrimSpace(track.TrackName) == "" || normalizedProviderCode(providerRejectionCode(track.ErrorCode, track.ErrorDescription)) != "track_not_found" {
			return false
		}
	}
	return failed > 0
}
