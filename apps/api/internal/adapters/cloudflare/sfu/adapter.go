package sfu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

const (
	forcedCloseTimeout      = 25 * time.Second
	sfuHTTP2SendPingTimeout = 5 * time.Second
	sfuHTTP2PingTimeout     = 5 * time.Second
	sfuIdleConnTimeout      = 90 * time.Second
	defaultEndpoint         = "https://rtc.live.cloudflare.com/v1"
	stunServer              = "stun:stun.cloudflare.com:3478"
	syncOwner               = "elixir"
)

var ErrMissingConfig = errors.New("missing cloudflare sfu config")

var sharedSFUTransport = sync.OnceValue(newSFUTransport)

const (
	failureStageTransport  providerFailureStage = "transport"
	failureStageHTTPStatus providerFailureStage = "http_status"
	failureStageDecode     providerFailureStage = "decode"
	failureStageTopLevel   providerFailureStage = "top_level"
	failureStageTrack      providerFailureStage = "track"
	failureStageContract   providerFailureStage = "contract"
)

var (
	sfuTracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu")

	sfuMeter = otel.Meter("github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu")

	sfuFailureCounter, _ = sfuMeter.Int64Counter(
		"chalk.api.cloudflare_sfu.failures",
		metric.WithDescription("Cloudflare SFU request failures by bounded operation and failure classification"),
	)
	sfuSessionReplacements, _ = sfuMeter.Int64Counter(
		"chalk.api.cloudflare_sfu.session_replacements",
		metric.WithDescription("Never-negotiated Cloudflare sessions swapped for a fresh one, by outcome (proactive, recovered or failed)"),
	)
)

type providerFailureStage string

type providerFailure struct {
	operation                  string
	stage                      providerFailureStage
	statusCode                 int
	statusClass                string
	providerCode               string
	transportCause             transportCause
	trackCode                  string
	details                    providerFailureDetails
	missingRemoteTracks        []mediaplane.RemoteTrackIdentity
	exactRemoteAbsence         bool
	partialRemoteTracks        bool
	retryableTrackAvailability bool
}

func (e providerFailure) Error() string {
	message := fmt.Sprintf(
		"cloudflare sfu %s failed: stage=%s status=%d status_class=%s provider_code=%s",
		e.operation,
		e.stage,
		e.statusCode,
		e.statusClass,
		e.providerCode,
	)
	if e.details.rawCode != "" {
		message += " provider_raw_code=" + e.details.rawCode
	}
	if e.details.message != "" {
		message += fmt.Sprintf(" provider_message=%q provider_message_fingerprint=%s", e.details.message, e.details.messageFingerprint)
	}
	return message
}

func (e providerFailure) ProviderFailureCode() string { return e.providerCode }

func (e providerFailure) Unwrap() error {
	switch {
	case e.transportCause == transportCauseCallerCanceled:
		return context.Canceled
	case e.providerCode == "plane_unavailable":
		return mediaplane.ErrPlaneUnavailable
	case e.statusCode == http.StatusUnauthorized, e.statusCode == http.StatusForbidden:
		return mediaplane.ErrProviderUnauthorized
	case e.statusCode == http.StatusNotFound, e.statusCode == http.StatusGone:
		if connectionOperation(e.operation) {
			return mediaplane.ErrConnectionNotFound
		}
		return mediaplane.ErrEpisodeNotFound
	case e.statusCode == http.StatusTooManyRequests:
		return mediaplane.ErrProviderRateLimited
	default:
		return mediaplane.ErrProviderFailed
	}
}

type httpClient interface {
	Do(*http.Request) (*http.Response, error)
}

type responseValidator interface {
	providerError(operation string) error
}

type providerErrorEnvelope struct {
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
	Errors           []struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

type Adapter struct {
	appID             string
	appSecret         string
	endpoint          string
	client            httpClient
	forcedCloseClient httpClient
	captureReplay     *captureReplayRegistry
	sessions          *sessionRegistry
	turn              *TurnCredentials
}

type ConnectionMetadata struct {
	Provider mediaplane.Provider
	Ref      string
	Metadata map[string]string
}

type createSessionResponse struct {
	SessionID string `json:"sessionId"`
}

type inspectSessionResponse struct {
	Tracks []struct {
		Location  string `json:"location"`
		Mid       string `json:"mid"`
		TrackName string `json:"trackName"`
		Status    string `json:"status"`
		SessionID string `json:"sessionId"`
	} `json:"tracks"`
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

type tracksRequest struct {
	SessionDescription *mediaplane.SessionDescription `json:"sessionDescription,omitempty"`
	Tracks             []providerTrack                `json:"tracks"`
}

type providerTrack struct {
	Simulcast *mediaplane.Simulcast `json:"simulcast,omitempty"`
	Location  string                `json:"location"`
	Mid       string                `json:"mid,omitempty"`
	TrackName string                `json:"trackName"`
	SessionID string                `json:"sessionId,omitempty"`
}

type addTracksResponse struct {
	ErrorCode                      string                         `json:"errorCode"`
	ErrorDescription               string                         `json:"errorDescription"`
	SessionDescription             *mediaplane.SessionDescription `json:"sessionDescription,omitempty"`
	Tracks                         []addTrackResult               `json:"tracks"`
	RequiresImmediateRenegotiation bool                           `json:"requiresImmediateRenegotiation"`
	requestedTracks                []providerTrack
	requestedLocalTracks           []providerTrack
}

type addTrackResult struct {
	Location         string `json:"location"`
	Mid              string `json:"mid"`
	TrackName        string `json:"trackName"`
	SessionID        string `json:"sessionId"`
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

type updateTracksResponse struct {
	ErrorCode                      string           `json:"errorCode"`
	ErrorDescription               string           `json:"errorDescription"`
	Tracks                         []addTrackResult `json:"tracks"`
	RequiresImmediateRenegotiation bool             `json:"requiresImmediateRenegotiation"`
	requestedTracks                []providerTrack
}

type renegotiateRequest struct {
	SessionDescription mediaplane.SessionDescription `json:"sessionDescription"`
}

type closeTracksRequest struct {
	SessionDescription *mediaplane.SessionDescription `json:"sessionDescription,omitempty"`
	Tracks             []closeTrack                   `json:"tracks"`
	Force              bool                           `json:"force"`
}

type closeTracksResponse struct {
	ErrorCode                      string                         `json:"errorCode"`
	ErrorDescription               string                         `json:"errorDescription"`
	SessionDescription             *mediaplane.SessionDescription `json:"sessionDescription,omitempty"`
	Tracks                         []closeTrackResult             `json:"tracks"`
	RequiresImmediateRenegotiation bool                           `json:"requiresImmediateRenegotiation"`
	requestedTracks                []mediaplane.CloseTrack
}

type closeTrack struct {
	Mid string `json:"mid"`
}

type closeTrackResult struct {
	Mid              string `json:"mid"`
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
}

func NewAdapter(cfg config.CloudflareRealtimeConfig) (Adapter, error) {
	return newAdapter(cfg, sharedSFUTransport())
}

func newAdapter(cfg config.CloudflareRealtimeConfig, transport *http.Transport) (Adapter, error) {
	appID := strings.TrimSpace(cfg.RealtimeAppID)
	appSecret := strings.TrimSpace(cfg.RealtimeAppSecret)
	if appID == "" || appSecret == "" || cfg.RequestTimeout <= 0 {
		return Adapter{}, ErrMissingConfig
	}

	endpoint := defaultEndpoint
	if strings.TrimSpace(cfg.RealtimeBaseURL) != "" {
		endpoint = strings.TrimRight(strings.TrimSpace(cfg.RealtimeBaseURL), "/")
	}

	return Adapter{
		appID:             appID,
		appSecret:         appSecret,
		endpoint:          endpoint,
		client:            &http.Client{Transport: transport, Timeout: cfg.RequestTimeout},
		forcedCloseClient: &http.Client{Transport: transport, Timeout: max(cfg.RequestTimeout, forcedCloseTimeout)},
		captureReplay:     newCaptureReplayRegistry(),
		sessions:          sessionRegistryForApp(appID),
	}, nil
}

func newSFUTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.IdleConnTimeout = sfuIdleConnTimeout
	transport.HTTP2 = &http.HTTP2Config{
		SendPingTimeout: sfuHTTP2SendPingTimeout,
		PingTimeout:     sfuHTTP2PingTimeout,
	}
	return transport
}

func NewAdapterWithClient(cfg config.CloudflareRealtimeConfig, client httpClient, endpoint string) (Adapter, error) {
	adapter, err := NewAdapter(cfg)
	if err != nil {
		return Adapter{}, err
	}
	if client != nil {
		adapter.client = client
		adapter.forcedCloseClient = client
	}
	if strings.TrimSpace(endpoint) != "" {
		adapter.endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
	}

	return adapter, nil
}

func (a Adapter) EnsureEpisode(_ context.Context, input mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.Episode{}, mediaplane.ErrInvalidProvider
	}

	return mediaplane.Episode{
		Provider: mediaplane.ProviderCloudflareSFU,
		Ref:      input.EpisodeKey,
		Metadata: a.providerMetadata(),
	}, nil
}

func (a Adapter) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.Join{}, mediaplane.ErrInvalidProvider
	}
	connectionID, err := a.createConnection(ctx)
	if err != nil {
		return mediaplane.Join{}, err
	}
	a.sessions.issue(connectionID)

	participantRef := input.ExternalParticipantID
	if participantRef == "" {
		participantRef = input.ParticipantName
	}

	return a.joinForConnection(input.Episode.Ref, participantRef, connectionID, a.iceServers(ctx, input.AllowRelay)), nil
}

func (a Adapter) ResumeJoin(ctx context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.Join{}, mediaplane.ErrInvalidProvider
	}

	return a.joinForConnection(input.Episode.Ref, input.ExternalParticipantID, input.ConnectionRef, a.iceServers(ctx, input.AllowRelay)), nil
}

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

func (a Adapter) InspectSession(ctx context.Context, connectionID string) (mediaplane.SessionState, error) {
	var response inspectSessionResponse
	statusCode, err := a.requestStatus(ctx, http.MethodGet, fmt.Sprintf("/sessions/%s", url.PathEscape(a.sessions.providerID(connectionID))), nil, &response, "get_session")
	if err != nil {
		var failure providerFailure
		if errors.As(err, &failure) && (failure.statusCode == http.StatusNotFound || failure.statusCode == http.StatusGone) {
			return mediaplane.SessionState{Found: false}, nil
		}
		return mediaplane.SessionState{}, err
	}
	code := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(response.ErrorCode), "-", "_"))
	if code == "session_not_found" || code == "connection_not_found" {
		return mediaplane.SessionState{Found: false}, nil
	}
	if strings.TrimSpace(response.ErrorCode) != "" {
		return mediaplane.SessionState{}, newProviderResponseFailure("get_session", failureStageTopLevel, statusCode, response.ErrorCode, response.ErrorDescription, len(response.Tracks), 0)
	}
	tracks := make([]mediaplane.SessionTrack, 0, len(response.Tracks))
	for _, track := range response.Tracks {
		tracks = append(tracks, mediaplane.SessionTrack{
			Location: track.Location, Mid: track.Mid, TrackName: track.TrackName,
			Active: !strings.EqualFold(strings.TrimSpace(track.Status), "inactive"),
		})
	}
	return mediaplane.SessionState{Found: true, Tracks: tracks}, nil
}

// UpdateTracks changes the simulcast layer of remote subscriptions in place.
// Cloudflare answers with requiresImmediateRenegotiation=false, so no SDP moves.
func (a Adapter) UpdateTracks(ctx context.Context, input mediaplane.UpdateTracksRequest) (mediaplane.TracksResponse, error) {
	tracks := make([]providerTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		tracks = append(tracks, providerTrack{Location: track.Location, Mid: track.Mid, TrackName: track.TrackName, SessionID: a.sessions.providerID(track.SessionID), Simulcast: track.Simulcast})
	}
	response := updateTracksResponse{requestedTracks: tracks}
	if err := a.request(ctx, http.MethodPut, fmt.Sprintf("/sessions/%s/tracks/update", url.PathEscape(a.sessions.providerID(input.ConnectionID))), tracksRequest{Tracks: tracks}, &response, "update_tracks"); err != nil {
		return mediaplane.TracksResponse{}, err
	}
	return a.toClientIDs(mediaplane.TracksResponse{Tracks: response.mediaPlaneTracks(), RequiresImmediateRenegotiation: response.RequiresImmediateRenegotiation}), nil
}

func (a Adapter) CloseTracks(ctx context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.CloseTracksResponse{}, mediaplane.ErrInvalidProvider
	}
	if input.ReceiveOnly {
		// The participant grant already binds this session to the caller. Verify
		// the MID's direction so this path cannot bypass publication retirement.
		var session struct {
			Tracks []struct {
				Mid      string `json:"mid"`
				Location string `json:"location"`
			} `json:"tracks"`
		}
		if err := a.request(ctx, http.MethodGet, fmt.Sprintf("/sessions/%s", url.PathEscape(a.sessions.providerID(input.ConnectionID))), nil, &session, "get_session"); err != nil {
			return mediaplane.CloseTracksResponse{}, err
		}
		for _, requested := range input.Tracks {
			matches := 0
			for _, track := range session.Tracks {
				if track.Mid != requested.Mid {
					continue
				}
				if track.Location != "remote" {
					return mediaplane.CloseTracksResponse{}, mediaplane.ErrInvalidSignalRequest
				}
				matches++
			}
			if matches != 1 {
				return mediaplane.CloseTracksResponse{}, mediaplane.ErrInvalidSignalRequest
			}
		}
		input.Force = true
		input.SessionDescription = nil
	}

	providerTracks := make([]closeTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		providerTracks = append(providerTracks, closeTrack{Mid: track.Mid})
	}

	request := closeTracksRequest{
		SessionDescription: input.SessionDescription,
		Tracks:             providerTracks,
		Force:              input.Force,
	}
	providerResponse := closeTracksResponse{requestedTracks: input.Tracks}
	// Disconnected provider connections can take longer than the interactive
	// request budget to report their absence. Keep teardown bounded separately.
	if input.Force && a.forcedCloseClient != nil {
		a.client = a.forcedCloseClient
	}
	err := a.request(ctx, http.MethodPut, fmt.Sprintf("/sessions/%s/tracks/close", url.PathEscape(a.sessions.providerID(input.ConnectionID))), request, &providerResponse, "close_tracks")
	if err != nil && !(input.Force && forcedCloseSatisfied(err)) {
		return mediaplane.CloseTracksResponse{}, err
	}
	alreadyClosed := input.Force && forcedCloseSatisfied(err)
	if err == nil && len(providerResponse.Tracks) > 0 {
		alreadyClosed = true
		for _, track := range providerResponse.Tracks {
			if !closedTrackAbsent(track.ErrorCode) {
				alreadyClosed = false
				break
			}
		}
	}
	return mediaplane.CloseTracksResponse{
		AlreadyClosed:                  alreadyClosed,
		SessionDescription:             providerResponse.SessionDescription,
		Tracks:                         input.Tracks,
		RequiresImmediateRenegotiation: providerResponse.RequiresImmediateRenegotiation,
	}, nil
}

func (a Adapter) Renegotiate(ctx context.Context, input mediaplane.RenegotiateRequest) error {
	err := a.request(ctx, http.MethodPut, fmt.Sprintf("/sessions/%s/renegotiate", url.PathEscape(a.sessions.providerID(input.ConnectionID))), renegotiateRequest{
		SessionDescription: input.SessionDescription,
	}, nil, "renegotiate")
	if err == nil {
		a.sessions.negotiated(input.ConnectionID)
	}
	return err
}

func (a Adapter) createConnection(ctx context.Context) (string, error) {
	var response createSessionResponse
	if err := a.request(ctx, http.MethodPost, "/sessions/new", nil, &response, "create_connection"); err != nil {
		return "", err
	}
	response.SessionID = strings.TrimSpace(response.SessionID)
	if response.SessionID == "" {
		return "", fmt.Errorf("decode sfu connection response: %w", mediaplane.ErrProviderFailed)
	}
	return response.SessionID, nil
}

func (a Adapter) request(ctx context.Context, method string, path string, body any, output any, operation string) error {
	_, err := a.requestStatus(ctx, method, path, body, output, operation)
	return err
}

// requestStatus returns the upstream HTTP status, or 0 when no response arrived.
func (a Adapter) requestStatus(ctx context.Context, method string, path string, body any, output any, operation string) (statusCode int, err error) {
	ctx, span := sfuTracer.Start(ctx, "mediaplane.cloudflare.sfu."+operation, trace.WithSpanKind(trace.SpanKindClient))
	responseBytes := 0
	defer func() {
		if err != nil {
			err = enrichProviderFailure(err, body, responseBytes)
			if !errors.Is(err, context.Canceled) {
				span.RecordError(sfuSpanError(err))
				span.SetStatus(codes.Error, "Cloudflare SFU request failed")
			}
			recordProviderFailure(ctx, span, err)
		}
		span.End()
	}()
	span.SetAttributes(attribute.String("http.request.method", method), attribute.String("server.address", "rtc.live.cloudflare.com"))

	if a.client == nil {
		return 0, newProviderFailure(operation, failureStageTransport, 0, "plane_unavailable")
	}
	var encoded []byte
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			return 0, newProviderFailure(operation, failureStageContract, 0, "invalid_request")
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("%s/apps/%s%s", a.endpoint, url.PathEscape(a.appID), path), bytes.NewReader(encoded))
	if err != nil {
		return 0, newProviderFailure(operation, failureStageContract, 0, "invalid_request")
	}
	request.Header.Set("Authorization", "Bearer "+a.appSecret)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	timing := &callTrace{}
	var responseHeader http.Header
	defer func() { timing.log(ctx, operation, traceInputFor(body), statusCode, responseHeader, traceFailed(err)) }()
	providerResponse, err := a.client.Do(request.WithContext(timing.attach(ctx)))
	if err != nil {
		return 0, newTransportFailure(ctx, operation, 0, err)
	}
	defer providerResponse.Body.Close()
	responseHeader = providerResponse.Header
	span.SetAttributes(attribute.Int("http.response.status_code", providerResponse.StatusCode))
	payload, err := io.ReadAll(io.LimitReader(providerResponse.Body, 1<<20))
	timing.readDone()
	if err != nil {
		return providerResponse.StatusCode, newTransportFailure(ctx, operation, providerResponse.StatusCode, err)
	}
	responseBytes = len(payload)
	if providerResponse.StatusCode < 200 || providerResponse.StatusCode >= 300 {
		return providerResponse.StatusCode, sfuStatusError(operation, providerResponse.StatusCode, payload)
	}
	if output != nil {
		if err := json.Unmarshal(payload, output); err != nil {
			return providerResponse.StatusCode, newProviderFailure(operation, failureStageDecode, providerResponse.StatusCode, "invalid_json")
		}
		if validator, ok := output.(responseValidator); ok {
			if err := validator.providerError(operation); err != nil {
				if response, ok := output.(*captureTracksResponse); ok {
					for _, track := range response.Tracks {
						if strings.EqualFold(strings.TrimSpace(track.ErrorCode), "not_found_track_error") {
							var failure providerFailure
							if errors.As(err, &failure) {
								failure.details.responseSnapshot = captureResponseSnapshot(payload)
								err = failure
							}
							break
						}
					}
				}
				return providerResponse.StatusCode, err
			}
		}
	}
	return providerResponse.StatusCode, nil
}

func (r *closeTracksResponse) providerError(operation string) error {
	if strings.TrimSpace(r.ErrorCode) != "" || strings.TrimSpace(r.ErrorDescription) != "" {
		return newProviderResponseFailure(operation, failureStageTopLevel, http.StatusOK, r.ErrorCode, r.ErrorDescription, len(r.Tracks), failedCloseTrackCount(r.Tracks))
	}

	requestedMids := make(map[string]struct{}, len(r.requestedTracks))
	for _, track := range r.requestedTracks {
		requestedMids[track.Mid] = struct{}{}
	}
	seenMids := make(map[string]struct{}, len(r.Tracks))
	for _, track := range r.Tracks {
		track.Mid = strings.TrimSpace(track.Mid)
		if _, ok := requestedMids[track.Mid]; !ok || track.Mid == "" {
			return newProviderFailure(operation, failureStageContract, http.StatusOK, "invalid_contract")
		}
		if _, duplicate := seenMids[track.Mid]; duplicate {
			return newProviderFailure(operation, failureStageContract, http.StatusOK, "invalid_contract")
		}
		seenMids[track.Mid] = struct{}{}
		if closedTrackAbsent(track.ErrorCode) {
			continue
		}
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			return newProviderResponseFailure(operation, failureStageTrack, http.StatusOK, track.ErrorCode, track.ErrorDescription, len(r.Tracks), failedCloseTrackCount(r.Tracks))
		}
	}
	if len(seenMids) != len(requestedMids) {
		return newProviderFailure(operation, failureStageContract, http.StatusOK, "invalid_contract")
	}

	return nil
}

func (r *updateTracksResponse) providerError(operation string) error {
	if strings.TrimSpace(r.ErrorCode) != "" || strings.TrimSpace(r.ErrorDescription) != "" {
		return newProviderResponseFailure(operation, failureStageTopLevel, http.StatusOK, r.ErrorCode, r.ErrorDescription, len(r.Tracks), failedAddTrackCount(r.Tracks))
	}
	requested := make(map[string]struct{}, len(r.requestedTracks))
	for _, track := range r.requestedTracks {
		requested[track.Mid] = struct{}{}
	}
	for _, track := range r.Tracks {
		if _, ok := requested[strings.TrimSpace(track.Mid)]; !ok {
			return newProviderFailure(operation, failureStageContract, http.StatusOK, "invalid_contract")
		}
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			return newProviderResponseFailure(operation, failureStageTrack, http.StatusOK, track.ErrorCode, track.ErrorDescription, len(r.Tracks), failedAddTrackCount(r.Tracks))
		}
	}
	if len(r.Tracks) != len(r.requestedTracks) {
		return newProviderFailure(operation, failureStageContract, http.StatusOK, "invalid_contract")
	}
	return nil
}

func (r updateTracksResponse) mediaPlaneTracks() []mediaplane.Track {
	tracks := make([]mediaplane.Track, 0, len(r.Tracks))
	for _, track := range r.Tracks {
		tracks = append(tracks, mediaplane.Track{Location: "remote", Mid: track.Mid, TrackName: track.TrackName, SessionID: track.SessionID})
	}
	return tracks
}

func (r *addTracksResponse) providerError(operation string) error {
	if strings.TrimSpace(r.ErrorCode) != "" || strings.TrimSpace(r.ErrorDescription) != "" {
		return newProviderResponseFailure(operation, failureStageTopLevel, http.StatusOK, r.ErrorCode, r.ErrorDescription, len(r.Tracks), failedAddTrackCount(r.Tracks))
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
			failure := newProviderResponseFailure(operation, failureStageTrack, http.StatusOK, track.ErrorCode, track.ErrorDescription, len(r.Tracks), failedAddTrackCount(r.Tracks))
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
			return newProviderFailure(operation, failureStageContract, http.StatusOK, "invalid_contract")
		}
		if _, duplicate := seen[identity]; duplicate {
			return newProviderFailure(operation, failureStageContract, http.StatusOK, "invalid_contract")
		}
		seen[identity] = struct{}{}
	}
	if len(seen) != len(requested) {
		return newProviderFailure(operation, failureStageContract, http.StatusOK, "invalid_contract")
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

func closedTrackAbsent(code string) bool {
	switch strings.ToLower(strings.TrimSpace(code)) {
	case "session_not_found", "connection_not_found", "track_already_closed", "track_not_found", "close_track_error":
		return true
	default:
		return false
	}
}

func forcedCloseSatisfied(err error) bool {
	var failure providerFailure
	if !errors.As(err, &failure) || failure.operation != "close_tracks" {
		return false
	}
	if failure.statusCode == http.StatusNotFound || failure.statusCode == http.StatusGone {
		return true
	}
	if failure.statusCode == http.StatusTooEarly {
		return failure.providerCode == "connection_not_connected"
	}
	return failure.statusCode == http.StatusOK &&
		(failure.providerCode == "connection_not_found" || failure.providerCode == "track_already_closed" || failure.providerCode == "track_not_found")
}

func newProviderFailure(operation string, stage providerFailureStage, statusCode int, providerCode string) providerFailure {
	return providerFailure{
		operation:    normalizedOperation(operation),
		stage:        stage,
		statusCode:   statusCode,
		statusClass:  providerStatusClass(statusCode),
		providerCode: normalizedProviderCode(providerCode),
	}
}

func normalizedOperation(operation string) string {
	switch operation {
	case "add_tracks", "close_tracks", "create_connection", "renegotiate", "update_tracks", "verify_connection":
		return operation
	default:
		return "unknown"
	}
}

func connectionOperation(operation string) bool {
	switch operation {
	case "add_tracks", "close_tracks", "renegotiate", "update_tracks", "verify_connection":
		return true
	default:
		return false
	}
}

func providerStatusClass(statusCode int) string {
	if statusCode < 100 || statusCode > 599 {
		return "none"
	}
	return fmt.Sprintf("%dxx", statusCode/100)
}

func providerRejectionCode(code string, message string) string {
	if strings.TrimSpace(code) == "" {
		if messageCode := providerMessageCode(message); messageCode != "" {
			return messageCode
		}
		return "provider_rejected"
	}
	return code
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

func failedCloseTrackCount(tracks []closeTrackResult) int {
	count := 0
	for _, track := range tracks {
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			count++
		}
	}
	return count
}

func normalizedProviderCode(code string) string {
	switch strings.ToLower(strings.TrimSpace(code)) {
	case "invalid_request", "bad_request":
		return "invalid_request"
	case "invalid_track":
		return "invalid_track"
	case "session_not_found", "connection_not_found":
		return "connection_not_found"
	case "session_not_connected", "not_connected", "connection_not_ready", "session_not_ready", "connection_not_connected":
		return "connection_not_connected"
	case "track_not_found":
		return "track_not_found"
	case "empty_track_error":
		return "empty_track_error"
	case "track_already_closed":
		return "track_already_closed"
	case "unauthorized", "forbidden":
		return "unauthorized"
	case "rate_limited", "too_many_requests":
		return "rate_limited"
	case "timeout", "request_timeout", "deadline_exceeded":
		return "timeout"
	case "transport_error":
		return "transport_error"
	case "client_canceled":
		return "client_canceled"
	case "plane_unavailable":
		return "plane_unavailable"
	case "invalid_json":
		return "invalid_json"
	case "invalid_contract":
		return "invalid_contract"
	case "provider_rejected":
		return "provider_rejected"
	case "internal_error", "upstream_error":
		return "provider_internal"
	default:
		return "unknown"
	}
}

// traceFailed reports whether a call trace should log at warn: any failure except a caller cancel.
func traceFailed(err error) bool {
	if err == nil {
		return false
	}
	var failure providerFailure
	return !errors.As(err, &failure) || failure.transportCause != transportCauseCallerCanceled
}

func recordProviderFailure(ctx context.Context, span trace.Span, err error) {
	var failure providerFailure
	if !errors.As(err, &failure) {
		return
	}
	attributes := []attribute.KeyValue{
		attribute.String("chalk.provider.operation", failure.operation),
		attribute.String("chalk.provider.failure_stage", string(failure.stage)),
		attribute.Int("http.response.status_code", failure.statusCode),
		attribute.String("http.response.status_class", failure.statusClass),
		attribute.String("chalk.provider.error_code", failure.providerCode),
	}
	if failure.transportCause != "" {
		attributes = append(attributes, attribute.String("chalk.provider.transport_cause", string(failure.transportCause)))
	}
	span.SetAttributes(attributes...)
	event := "cloudflare_sfu.provider_failure"
	logEvent := "cloudflare_sfu.request_failed"
	message := "Cloudflare SFU request failed"
	level := slog.LevelWarn
	if failure.transportCause == transportCauseCallerCanceled {
		event, logEvent, message = "cloudflare_sfu.client_canceled", "cloudflare_sfu.client_canceled", "Cloudflare SFU request canceled by caller"
		level = slog.LevelInfo
	} else {
		sfuFailureCounter.Add(ctx, 1, metric.WithAttributes(attributes...))
		if failure.stage == failureStageTransport || failure.statusClass == "5xx" {
			level = slog.LevelError
		}
	}
	span.AddEvent(
		event,
		trace.WithAttributes(
			attribute.String("chalk.provider.raw_error_code", failure.details.rawCode),
			attribute.String("chalk.provider.track_error_code", failure.details.trackErrorCode),
			attribute.String("chalk.provider.message", failure.details.message),
			attribute.String("chalk.provider.message_fingerprint", failure.details.messageFingerprint),
			attribute.Int("chalk.provider.response_bytes", failure.details.responseBytes),
			attribute.String("chalk.provider.response_snapshot", failure.details.responseSnapshot),
			attribute.Int("chalk.provider.request_track_count", failure.details.requestTrackCount),
			attribute.Int("chalk.provider.response_track_count", failure.details.responseTrackCount),
			attribute.Int("chalk.provider.failed_track_count", failure.details.failedTrackCount),
		),
	)
	slog.Default().Log(
		ctx,
		level,
		message,
		"event", logEvent,
		"operation", failure.operation,
		"failure_stage", string(failure.stage),
		"http_status", failure.statusCode,
		"http_status_class", failure.statusClass,
		"provider_code", failure.providerCode,
		"transport_cause", string(failure.transportCause),
		"provider_raw_code", failure.details.rawCode,
		"provider_track_error_code", failure.details.trackErrorCode,
		"provider_message", failure.details.message,
		"provider_message_fingerprint", failure.details.messageFingerprint,
		"provider_response_bytes", failure.details.responseBytes,
		"provider_response_snapshot", failure.details.responseSnapshot,
		"request_track_count", failure.details.requestTrackCount,
		"request_local_track_count", failure.details.localTrackCount,
		"request_remote_track_count", failure.details.remoteTrackCount,
		"response_track_count", failure.details.responseTrackCount,
		"failed_track_count", failure.details.failedTrackCount,
		"trace_id", span.SpanContext().TraceID().String(),
		"span_id", span.SpanContext().SpanID().String(),
	)
}

func sfuSpanError(err error) error {
	switch {
	case errors.Is(err, mediaplane.ErrPlaneUnavailable):
		return mediaplane.ErrPlaneUnavailable
	case errors.Is(err, mediaplane.ErrProviderUnauthorized):
		return mediaplane.ErrProviderUnauthorized
	case errors.Is(err, mediaplane.ErrProviderRateLimited):
		return mediaplane.ErrProviderRateLimited
	case errors.Is(err, mediaplane.ErrConnectionNotFound):
		return mediaplane.ErrConnectionNotFound
	case errors.Is(err, mediaplane.ErrEpisodeNotFound):
		return mediaplane.ErrEpisodeNotFound
	default:
		return mediaplane.ErrProviderFailed
	}
}

func (a Adapter) RemoveParticipant(context.Context, mediaplane.RemoveParticipantInput) error {
	return mediaplane.ErrUnsupportedOperation
}

func (a Adapter) EndEpisode(context.Context, mediaplane.EndEpisodeInput) error {
	return mediaplane.ErrUnsupportedOperation
}

func (a Adapter) EpisodeUsage(_ context.Context, input mediaplane.EpisodeUsageInput) (mediaplane.Usage, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.Usage{}, mediaplane.ErrInvalidProvider
	}

	return mediaplane.Usage{Metadata: a.providerMetadata()}, nil
}

func (a Adapter) VerifyConnectionMetadata(ctx context.Context, connectionRef string) (metadata ConnectionMetadata, err error) {
	connectionRef = strings.TrimSpace(connectionRef)
	if connectionRef == "" {
		return ConnectionMetadata{}, mediaplane.ErrInvalidConnectionRef
	}
	ctx, span := sfuTracer.Start(ctx, "mediaplane.cloudflare.sfu.verify_connection", trace.WithSpanKind(trace.SpanKindClient))
	defer func() {
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				span.RecordError(sfuSpanError(err))
				span.SetStatus(codes.Error, "Cloudflare SFU request failed")
			}
			recordProviderFailure(ctx, span, err)
		}
		span.End()
	}()
	span.SetAttributes(attribute.String("http.request.method", http.MethodGet), attribute.String("server.address", "rtc.live.cloudflare.com"))

	if a.client == nil {
		return ConnectionMetadata{}, newProviderFailure("verify_connection", failureStageTransport, 0, "plane_unavailable")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/apps/%s/sessions/%s", a.endpoint, url.PathEscape(a.appID), url.PathEscape(connectionRef)), nil)
	if err != nil {
		return ConnectionMetadata{}, newProviderFailure("verify_connection", failureStageContract, 0, "invalid_request")
	}
	request.Header.Set("Authorization", "Bearer "+a.appSecret)
	request.Header.Set("Accept", "application/json")

	response, err := a.client.Do(request)
	if err != nil {
		return ConnectionMetadata{}, newTransportFailure(ctx, "verify_connection", 0, err)
	}
	defer response.Body.Close()
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))

	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return ConnectionMetadata{}, newTransportFailure(ctx, "verify_connection", response.StatusCode, err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		failure := sfuStatusError("verify_connection", response.StatusCode, payload)
		return ConnectionMetadata{}, enrichProviderFailure(failure, nil, len(payload))
	}

	return ConnectionMetadata{
		Provider: mediaplane.ProviderCloudflareSFU,
		Ref:      connectionRef,
		Metadata: a.providerMetadata(),
	}, nil
}

func (a Adapter) providerMetadata() map[string]string {
	return map[string]string{
		"api_base":    fmt.Sprintf("%s/apps/%s", a.endpoint, a.appID),
		"app_id":      a.appID,
		"stun_server": stunServer,
		"sync_owner":  syncOwner,
	}
}

func (a Adapter) joinForConnection(episodeRef string, participantRef string, connectionID string, iceServers []mediaplane.ICEServer) mediaplane.Join {
	return mediaplane.Join{
		Provider:       mediaplane.ProviderCloudflareSFU,
		ParticipantRef: participantRef,
		ClientPayload: map[string]any{
			"connectionId": connectionID,
			"provider":     string(mediaplane.ProviderCloudflareSFU),
			"episodeRef":   episodeRef,
			"stunServer":   stunServer,
			"iceServers":   iceServers,
			"syncOwner":    syncOwner,
		},
		Metadata: a.providerMetadata(),
	}
}

func sfuStatusError(operation string, statusCode int, payload []byte) error {
	var envelope providerErrorEnvelope
	_ = json.Unmarshal(payload, &envelope)
	code := envelope.ErrorCode
	message := envelope.ErrorDescription
	if strings.TrimSpace(code) == "" {
		for _, providerError := range envelope.Errors {
			if strings.TrimSpace(providerError.Code) != "" {
				code = providerError.Code
			}
			if strings.TrimSpace(message) == "" {
				message = providerError.Message
			}
			if strings.TrimSpace(code) != "" && strings.TrimSpace(message) != "" {
				break
			}
		}
	}
	if strings.TrimSpace(code) == "" {
		switch statusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			code = "unauthorized"
		case http.StatusNotFound, http.StatusGone:
			code = "session_not_found"
		case http.StatusTooManyRequests:
			code = "rate_limited"
		case http.StatusTooEarly:
			code = "session_not_connected"
		case http.StatusRequestTimeout, http.StatusGatewayTimeout:
			code = "timeout"
		default:
			code = "unknown"
		}
	}

	if statusCode == http.StatusTooEarly && code == "session_error" && providerMessageCode(message) == "connection_not_connected" {
		code = "session_not_connected"
	}
	failure := newProviderFailure(operation, failureStageHTTPStatus, statusCode, providerRejectionCode(code, message))
	failure.details.rawCode = observableHTTPProviderCode(payload)
	return failure
}
