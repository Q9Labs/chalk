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

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

const (
	defaultEndpoint = "https://rtc.live.cloudflare.com/v1"
	stunServer      = "stun:stun.cloudflare.com:3478"
	syncOwner       = "elixir"
)

var ErrMissingConfig = errors.New("missing cloudflare sfu config")

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

	sfuFailureCounter, _ = otel.Meter("github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu").Int64Counter(
		"chalk.api.cloudflare_sfu.failures",
		metric.WithDescription("Cloudflare SFU request failures by bounded operation and failure classification"),
	)
)

type providerFailureStage string

type providerFailure struct {
	operation    string
	stage        providerFailureStage
	statusCode   int
	statusClass  string
	providerCode string
	details      providerFailureDetails
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

func (e providerFailure) Unwrap() error {
	switch {
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
	appID     string
	appSecret string
	endpoint  string
	client    httpClient
}

type ConnectionMetadata struct {
	Provider mediaplane.Provider
	Ref      string
	Metadata map[string]string
}

type createSessionResponse struct {
	SessionID string `json:"sessionId"`
}

type tracksRequest struct {
	SessionDescription *mediaplane.SessionDescription `json:"sessionDescription,omitempty"`
	Tracks             []providerTrack                `json:"tracks"`
}

type providerTrack struct {
	Location  string `json:"location"`
	Mid       string `json:"mid,omitempty"`
	TrackName string `json:"trackName"`
	SessionID string `json:"sessionId,omitempty"`
}

type addTracksResponse struct {
	ErrorCode                      string                         `json:"errorCode"`
	ErrorDescription               string                         `json:"errorDescription"`
	SessionDescription             *mediaplane.SessionDescription `json:"sessionDescription,omitempty"`
	Tracks                         []addTrackResult               `json:"tracks"`
	RequiresImmediateRenegotiation bool                           `json:"requiresImmediateRenegotiation"`
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
		appID:     appID,
		appSecret: appSecret,
		endpoint:  endpoint,
		client:    &http.Client{Timeout: cfg.RequestTimeout},
	}, nil
}

func NewAdapterWithClient(cfg config.CloudflareRealtimeConfig, client httpClient, endpoint string) (Adapter, error) {
	adapter, err := NewAdapter(cfg)
	if err != nil {
		return Adapter{}, err
	}
	if client != nil {
		adapter.client = client
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

	participantRef := input.ExternalParticipantID
	if participantRef == "" {
		participantRef = input.ParticipantName
	}

	return a.joinForConnection(input.Episode.Ref, participantRef, connectionID), nil
}

func (a Adapter) ResumeJoin(_ context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.Join{}, mediaplane.ErrInvalidProvider
	}

	return a.joinForConnection(input.Episode.Ref, input.ExternalParticipantID, input.ConnectionRef), nil
}

func (a Adapter) AddTracks(ctx context.Context, input mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	tracks := make([]providerTrack, 0, len(input.Tracks))
	localTracks := make([]providerTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		providerTrack := providerTrack{Location: track.Location, Mid: track.Mid, TrackName: track.TrackName, SessionID: track.SessionID}
		tracks = append(tracks, providerTrack)
		if track.Location == "local" {
			localTracks = append(localTracks, providerTrack)
		}
	}
	request := tracksRequest{
		SessionDescription: input.SessionDescription,
		Tracks:             tracks,
	}
	response := addTracksResponse{requestedLocalTracks: localTracks}
	err := a.request(ctx, http.MethodPost, fmt.Sprintf("/sessions/%s/tracks/new", url.PathEscape(input.ConnectionID)), request, &response, "add_tracks")
	if err != nil {
		return mediaplane.TracksResponse{}, err
	}
	return response.toMediaPlane(), nil
}

func (a Adapter) CloseTracks(ctx context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.CloseTracksResponse{}, mediaplane.ErrInvalidProvider
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
	err := a.request(ctx, http.MethodPut, fmt.Sprintf("/sessions/%s/tracks/close", url.PathEscape(input.ConnectionID)), request, &providerResponse, "close_tracks")
	if err != nil {
		return mediaplane.CloseTracksResponse{}, err
	}
	return mediaplane.CloseTracksResponse{
		SessionDescription:             providerResponse.SessionDescription,
		Tracks:                         input.Tracks,
		RequiresImmediateRenegotiation: providerResponse.RequiresImmediateRenegotiation,
	}, nil
}

func (a Adapter) Renegotiate(ctx context.Context, input mediaplane.RenegotiateRequest) error {
	return a.request(ctx, http.MethodPut, fmt.Sprintf("/sessions/%s/renegotiate", url.PathEscape(input.ConnectionID)), renegotiateRequest{
		SessionDescription: input.SessionDescription,
	}, nil, "renegotiate")
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

func (a Adapter) request(ctx context.Context, method string, path string, body any, output any, operation string) (err error) {
	ctx, span := sfuTracer.Start(ctx, "mediaplane.cloudflare.sfu."+operation, trace.WithSpanKind(trace.SpanKindClient))
	responseBytes := 0
	defer func() {
		if err != nil {
			err = enrichProviderFailure(err, body, responseBytes)
			span.RecordError(sfuSpanError(err))
			span.SetStatus(codes.Error, "Cloudflare SFU request failed")
			recordProviderFailure(ctx, span, err)
		}
		span.End()
	}()
	span.SetAttributes(attribute.String("http.request.method", method), attribute.String("server.address", "rtc.live.cloudflare.com"))

	if a.client == nil {
		return newProviderFailure(operation, failureStageTransport, 0, "plane_unavailable")
	}
	var encoded []byte
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			return newProviderFailure(operation, failureStageContract, 0, "invalid_request")
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("%s/apps/%s%s", a.endpoint, url.PathEscape(a.appID), path), bytes.NewReader(encoded))
	if err != nil {
		return newProviderFailure(operation, failureStageContract, 0, "invalid_request")
	}
	request.Header.Set("Authorization", "Bearer "+a.appSecret)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	providerResponse, err := a.client.Do(request)
	if err != nil {
		code := "transport_error"
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code = "timeout"
		}
		return newProviderFailure(operation, failureStageTransport, 0, code)
	}
	defer providerResponse.Body.Close()
	span.SetAttributes(attribute.Int("http.response.status_code", providerResponse.StatusCode))
	payload, err := io.ReadAll(io.LimitReader(providerResponse.Body, 1<<20))
	if err != nil {
		return newProviderFailure(operation, failureStageTransport, providerResponse.StatusCode, "transport_error")
	}
	responseBytes = len(payload)
	if providerResponse.StatusCode < 200 || providerResponse.StatusCode >= 300 {
		return sfuStatusError(operation, providerResponse.StatusCode, payload)
	}
	if output != nil {
		if err := json.Unmarshal(payload, output); err != nil {
			return newProviderFailure(operation, failureStageDecode, providerResponse.StatusCode, "invalid_json")
		}
		if validator, ok := output.(responseValidator); ok {
			if err := validator.providerError(operation); err != nil {
				return err
			}
		}
	}
	return nil
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

func (r *addTracksResponse) providerError(operation string) error {
	if strings.TrimSpace(r.ErrorCode) != "" || strings.TrimSpace(r.ErrorDescription) != "" {
		return newProviderResponseFailure(operation, failureStageTopLevel, http.StatusOK, r.ErrorCode, r.ErrorDescription, len(r.Tracks), failedAddTrackCount(r.Tracks))
	}

	type localTrackIdentity struct {
		mid       string
		trackName string
	}
	requested := make(map[localTrackIdentity]struct{}, len(r.requestedLocalTracks))
	for _, track := range r.requestedLocalTracks {
		requested[localTrackIdentity{mid: track.Mid, trackName: track.TrackName}] = struct{}{}
	}

	seen := make(map[localTrackIdentity]struct{}, len(requested))
	for _, track := range r.Tracks {
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			return newProviderResponseFailure(operation, failureStageTrack, http.StatusOK, track.ErrorCode, track.ErrorDescription, len(r.Tracks), failedAddTrackCount(r.Tracks))
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

func (r addTracksResponse) toMediaPlane() mediaplane.TracksResponse {
	tracks := make([]mediaplane.Track, 0, len(r.Tracks))
	for _, track := range r.Tracks {
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
		RequiresImmediateRenegotiation: r.RequiresImmediateRenegotiation,
	}
}

func closedTrackAbsent(code string) bool {
	switch strings.ToLower(strings.TrimSpace(code)) {
	case "session_not_found", "track_already_closed", "track_not_found":
		return true
	default:
		return false
	}
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
	case "add_tracks", "close_tracks", "create_connection", "renegotiate", "verify_connection":
		return operation
	default:
		return "unknown"
	}
}

func connectionOperation(operation string) bool {
	switch operation {
	case "add_tracks", "close_tracks", "renegotiate", "verify_connection":
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
	span.SetAttributes(attributes...)
	span.AddEvent(
		"cloudflare_sfu.provider_failure",
		trace.WithAttributes(
			attribute.String("chalk.provider.raw_error_code", failure.details.rawCode),
			attribute.String("chalk.provider.message_fingerprint", failure.details.messageFingerprint),
			attribute.Int("chalk.provider.response_bytes", failure.details.responseBytes),
			attribute.Int("chalk.provider.request_track_count", failure.details.requestTrackCount),
			attribute.Int("chalk.provider.response_track_count", failure.details.responseTrackCount),
			attribute.Int("chalk.provider.failed_track_count", failure.details.failedTrackCount),
		),
	)
	sfuFailureCounter.Add(ctx, 1, metric.WithAttributes(attributes...))

	level := slog.LevelWarn
	if failure.stage == failureStageTransport || failure.statusClass == "5xx" {
		level = slog.LevelError
	}
	slog.Default().Log(
		ctx,
		level,
		"Cloudflare SFU request failed",
		"event", "cloudflare_sfu.request_failed",
		"operation", failure.operation,
		"failure_stage", failure.stage,
		"http_status", failure.statusCode,
		"http_status_class", failure.statusClass,
		"provider_code", failure.providerCode,
		"provider_raw_code", failure.details.rawCode,
		"provider_message", failure.details.message,
		"provider_message_fingerprint", failure.details.messageFingerprint,
		"provider_response_bytes", failure.details.responseBytes,
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
			span.RecordError(sfuSpanError(err))
			span.SetStatus(codes.Error, "Cloudflare SFU request failed")
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
		code := "transport_error"
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code = "timeout"
		}
		return ConnectionMetadata{}, newProviderFailure("verify_connection", failureStageTransport, 0, code)
	}
	defer response.Body.Close()
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))

	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return ConnectionMetadata{}, newProviderFailure("verify_connection", failureStageTransport, response.StatusCode, "transport_error")
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

func (a Adapter) joinForConnection(episodeRef string, participantRef string, connectionID string) mediaplane.Join {
	return mediaplane.Join{
		Provider:       mediaplane.ProviderCloudflareSFU,
		ParticipantRef: participantRef,
		ClientPayload: map[string]any{
			"connectionId": connectionID,
			"provider":     string(mediaplane.ProviderCloudflareSFU),
			"episodeRef":   episodeRef,
			"stunServer":   stunServer,
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

	return newProviderResponseFailure(operation, failureStageHTTPStatus, statusCode, code, message, 0, 0)
}
