// Package chalksfu is the media-plane adapter for Chalk's own SFU. It speaks the
// SFU's mutual-TLS control API and keeps no state of its own: every mutation
// carries an operation ID that stays the same across this adapter's HTTP retries,
// so the SFU runs it once.
package chalksfu

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

const (
	maxResponseBytes = 1 << 20
	maxAttempts      = 3
	retryBackoff     = 150 * time.Millisecond
)

var ErrMissingConfig = errors.New("missing chalk sfu config")

// turnMintFailures counts joins that went out without TURN. A client that can
// reach only TCP 443 cannot connect media after one, so it is the signal to watch.
// Its only attribute is the media plane: an Episode id would make it unbounded.
var turnMintFailures, _ = otel.Meter("github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu").Int64Counter(
	"chalk.sfu.turn_mint_failures",
	metric.WithDescription("Joins that got STUN only because minting TURN credentials failed"),
	metric.WithUnit("{join}"),
)

// Adapter is the media plane of one SFU node. Fleet builds one per configured node.
type Adapter struct {
	node          string
	base          *url.URL
	client        *http.Client
	applicationID string
	iceServers    []mediaplane.ICEServer
	relay         RelaySource
	backoff       time.Duration
	captureReplay *captureplane.ReplayCache
}

// RelaySource hands out TURN servers. The SFU has no TCP media, so a client
// that can reach only TCP 443 joins through a relay.
type RelaySource interface {
	RelayServers(ctx context.Context) ([]mediaplane.ICEServer, error)
}

// WithRelay returns the node's adapter with a TURN source for joins that allow
// relay.
func (a *Adapter) WithRelay(relay RelaySource) *Adapter {
	withRelay := *a
	withRelay.relay = relay
	return &withRelay
}

// iceServersFor gives relay servers only to joins the caller allows to relay.
// A TURN failure never fails a join: the client falls back to STUN.
func (a *Adapter) iceServersFor(ctx context.Context, episodeID string, allowRelay bool) []mediaplane.ICEServer {
	if !allowRelay || a.relay == nil {
		return a.iceServers
	}
	servers, err := a.relay.RelayServers(ctx)
	if err != nil && ctx.Err() != nil {
		// The caller gave up, so no client gets this join and nothing failed to mint.
		return a.iceServers
	}
	if err != nil {
		slog.WarnContext(ctx, "TURN credentials unavailable; own-SFU clients use STUN only",
			"event", "chalk_sfu.turn_credentials_failed", "node", a.node, "episode_id", episodeID, "error", err.Error())
		turnMintFailures.Add(ctx, 1, metric.WithAttributes(attribute.String("chalk.media_plane.provider", string(mediaplane.ProviderChalkSFU))))
		return a.iceServers
	}
	return append(slices.Clone(a.iceServers), servers...)
}

// newClient builds the mTLS client once for every node. The server certificate
// must verify against the configured CA and name ServerName, and the client
// presents its own certificate, so a stolen network position cannot reach the
// control API.
func newClient(config runtimeconfig.ChalkSFUConfig) (*http.Client, error) {
	if config.ApplicationID == "" || config.ServerName == "" || config.RequestTimeout <= 0 {
		return nil, fmt.Errorf("%w: application ID, server name and timeout", ErrMissingConfig)
	}
	roots, err := loadPool(config.CAFile)
	if err != nil {
		return nil, err
	}
	certificate, err := tls.LoadX509KeyPair(config.ClientCertFile, config.ClientKeyFile)
	if err != nil {
		return nil, fmt.Errorf("%w: client certificate: %v", ErrMissingConfig, err)
	}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion:   tls.VersionTLS13,
			RootCAs:      roots,
			ServerName:   config.ServerName,
			Certificates: []tls.Certificate{certificate},
		},
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
	}
	return &http.Client{Transport: transport, Timeout: config.RequestTimeout}, nil
}

func newAdapter(config runtimeconfig.ChalkSFUConfig, node runtimeconfig.ChalkSFUNode, client *http.Client) (*Adapter, error) {
	base, err := url.Parse(strings.TrimSpace(node.ControlURL))
	if err != nil || base.Scheme != "https" || base.Host == "" {
		return nil, fmt.Errorf("%w: node %q control URL must be https", ErrMissingConfig, node.ID)
	}
	if !mediaplane.ValidNodeID(node.ID) {
		return nil, fmt.Errorf("%w: node ID %q", ErrMissingConfig, node.ID)
	}
	return &Adapter{
		node:          node.ID,
		base:          base,
		client:        client,
		applicationID: config.ApplicationID,
		iceServers:    iceServersOf(config.STUNURLs),
		backoff:       retryBackoff,
		captureReplay: captureplane.NewReplayCache(captureReplayCapacity),
	}, nil
}

func loadPool(path string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%w: CA file: %v", ErrMissingConfig, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("%w: CA file has no certificate", ErrMissingConfig)
	}
	return pool, nil
}

// NodeID is the stable name of the node this adapter calls.
func (a *Adapter) NodeID() string { return a.node }

func newOperationID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "op-" + hex.EncodeToString(raw[:]), nil
}

// call posts one JSON body and decodes the reply. Transport failures and 502, 503
// and 504 replies retry with the same body, so the operation ID inside it makes
// the retry safe. Any other status is the answer.
func (a *Adapter) call(ctx context.Context, path string, request, response any) error {
	body, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("%w: encode request", mediaplane.ErrProviderFailed)
	}
	endpoint := a.base.JoinPath(path).String()
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if attempt > 1 {
			select {
			case <-ctx.Done():
				return fmt.Errorf("%w: %v", mediaplane.ErrPlaneUnavailable, ctx.Err())
			case <-time.After(a.backoff * time.Duration(attempt-1)):
			}
		}
		status, payload, err := a.send(ctx, endpoint, body)
		switch {
		case err != nil:
			lastErr = fmt.Errorf("%w: transport: %v", mediaplane.ErrProviderFailed, err)
		case status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout:
			lastErr = classify(status, payload)
		case status >= 200 && status < 300:
			if response == nil {
				return nil
			}
			if err := json.Unmarshal(payload, response); err != nil {
				return fmt.Errorf("%w: decode response", mediaplane.ErrProviderFailed)
			}
			return nil
		default:
			return classify(status, payload)
		}
		if ctx.Err() != nil {
			return lastErr
		}
	}
	return lastErr
}

// ready reads the node's readiness: its packet budget and the part live Episodes
// reserve. Any reply but 200, a draining node's 503 included, is not ready.
func (a *Adapter) ready(ctx context.Context) (wireReady, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base.JoinPath("/readyz").String(), nil)
	if err != nil {
		return wireReady{}, err
	}
	request.Header.Set("Accept", "application/json")
	reply, err := a.client.Do(request)
	if err != nil {
		return wireReady{}, err
	}
	defer reply.Body.Close()
	if reply.StatusCode != http.StatusOK {
		return wireReady{}, fmt.Errorf("readiness status %d", reply.StatusCode)
	}
	var ready wireReady
	if err := json.NewDecoder(io.LimitReader(reply.Body, maxResponseBytes)).Decode(&ready); err != nil {
		return wireReady{}, fmt.Errorf("decode readiness: %w", err)
	}
	return ready, nil
}

func (a *Adapter) send(ctx context.Context, endpoint string, body []byte) (int, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	reply, err := a.client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer reply.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(reply.Body, maxResponseBytes))
	return reply.StatusCode, payload, err
}

// errStaleGeneration means the SFU holds a newer generation of the session's scope.
var errStaleGeneration = errors.New("sfu session generation is stale")

// classify turns an SFU error reply into the port's errors. A gone session is
// the one case callers act on: it means the connection no longer exists.
func classify(status int, payload []byte) error {
	var envelope wireError
	_ = json.Unmarshal(payload, &envelope)
	code := envelope.Error.Code
	switch {
	case status == http.StatusNotFound || code == "session_gone":
		return fmt.Errorf("%w: sfu %s", mediaplane.ErrConnectionNotFound, code)
	case status == http.StatusBadRequest:
		return fmt.Errorf("%w: sfu %s", mediaplane.ErrInvalidSignalRequest, code)
	case code == "stale_generation":
		return fmt.Errorf("%w: %w: sfu %s", mediaplane.ErrProviderFailed, errStaleGeneration, code)
	case status == http.StatusTooManyRequests:
		return fmt.Errorf("%w: %w: sfu %s", mediaplane.ErrProviderFailed, mediaplane.ErrProviderRateLimited, code)
	case status == http.StatusForbidden:
		return fmt.Errorf("%w: %w: sfu %s", mediaplane.ErrProviderFailed, mediaplane.ErrProviderUnauthorized, code)
	case status == http.StatusNotImplemented:
		return fmt.Errorf("%w: sfu %s", mediaplane.ErrUnsupportedOperation, code)
	default:
		return fmt.Errorf("%w: sfu status %d %s", mediaplane.ErrProviderFailed, status, code)
	}
}

func wireScopeOf(scope mediaplane.Scope) wireScope {
	return wireScope{TenantID: scope.TenantID, EpisodeID: scope.EpisodeID, ParticipantID: scope.ParticipantID, Generation: scope.Generation}
}

func sessionPath(connectionID, action string) (string, error) {
	if strings.TrimSpace(connectionID) == "" || connectionID != strings.TrimSpace(connectionID) || strings.ContainsAny(connectionID, "/?#") {
		return "", mediaplane.ErrInvalidConnectionRef
	}
	return "/v1/sessions/" + url.PathEscape(connectionID) + "/" + action, nil
}

func (a *Adapter) EnsureEpisode(_ context.Context, input mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	if input.Provider != mediaplane.ProviderChalkSFU {
		return mediaplane.Episode{}, mediaplane.ErrInvalidProvider
	}
	return mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: input.EpisodeKey, Metadata: a.metadata()}, nil
}

func (a *Adapter) metadata() map[string]string {
	return map[string]string{"application_id": a.applicationID}
}

// join builds the client payload. The SFU picks each subscriber's layer from its
// own estimate and treats the SDK's layer as a ceiling, and it reports each
// subscription's delivery state, so the SDK reads that before it repulls. It
// restarts ICE in place, so the SDK tries that before it replaces the session.
func (a *Adapter) join(episodeRef, participantRef, connectionID string, iceServers []mediaplane.ICEServer) mediaplane.Join {
	return mediaplane.Join{
		Provider:       mediaplane.ProviderChalkSFU,
		ParticipantRef: participantRef,
		ClientPayload: map[string]any{
			"connectionId": connectionID,
			"provider":     string(mediaplane.ProviderChalkSFU),
			"episodeRef":   episodeRef,
			"iceServers":   iceServers,
			"capabilities": map[string]any{"serverLayerAdaptation": true, "subscriptionState": true, "iceRestart": true},
		},
		Metadata: a.metadata(),
	}
}

func (a *Adapter) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	if input.Provider != mediaplane.ProviderChalkSFU {
		return mediaplane.Join{}, mediaplane.ErrInvalidProvider
	}
	operationID, err := newOperationID()
	if err != nil {
		return mediaplane.Join{}, fmt.Errorf("%w: operation id", mediaplane.ErrProviderFailed)
	}
	var created wireCreateResponse
	request := wireCreateRequest{OperationID: operationID, Scope: wireScopeOf(input.Scope)}
	if err := a.call(ctx, "/v1/sessions", request, &created); err != nil {
		return mediaplane.Join{}, err
	}
	participantRef := input.ExternalParticipantID
	if participantRef == "" {
		participantRef = input.ParticipantName
	}
	return a.join(input.Episode.Ref, participantRef, created.ConnectionID, a.iceServersFor(ctx, input.Scope.EpisodeID, input.AllowRelay)), nil
}

// ResumeJoin hands back the same connection when the SFU still holds it. The SFU
// has no resume route: a gone session means the client must create a new one.
func (a *Adapter) ResumeJoin(ctx context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	if input.Provider != mediaplane.ProviderChalkSFU {
		return mediaplane.Join{}, mediaplane.ErrInvalidProvider
	}
	state, err := a.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: input.ConnectionRef, Scope: input.Scope})
	if err != nil {
		return mediaplane.Join{}, err
	}
	if !state.Found {
		return mediaplane.Join{}, mediaplane.ErrConnectionNotFound
	}
	return a.join(input.Episode.Ref, input.ExternalParticipantID, input.ConnectionRef, a.iceServersFor(ctx, input.Scope.EpisodeID, input.AllowRelay)), nil
}

func (a *Adapter) AddTracks(ctx context.Context, input mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	path, err := sessionPath(input.ConnectionID, "tracks")
	if err != nil {
		return mediaplane.TracksResponse{}, err
	}
	operationID, err := newOperationID()
	if err != nil {
		return mediaplane.TracksResponse{}, fmt.Errorf("%w: operation id", mediaplane.ErrProviderFailed)
	}
	request := wireTracksRequest{
		OperationID:        operationID,
		Scope:              wireScopeOf(input.Scope),
		SessionDescription: wireDescriptionOf(input.SessionDescription),
		Tracks:             wireTracksOf(input.Tracks),
	}
	var response wireTracksResponse
	if err := a.call(ctx, path, request, &response); err != nil {
		return mediaplane.TracksResponse{}, err
	}
	return tracksResponseOf(input.ConnectionID, response), nil
}

// RestartICE sends the client's ICE restart offer as a push with no tracks. The
// SFU renegotiates the connection in place and answers with new credentials.
func (a *Adapter) RestartICE(ctx context.Context, input mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	return a.AddTracks(ctx, mediaplane.TracksRequest{ConnectionID: input.ConnectionID, Scope: input.Scope, SessionDescription: input.SessionDescription})
}

// UpdateTracks changes a subscription's layer ceiling or pauses and resumes it in
// place. The MID and track stay, so no renegotiation follows.
func (a *Adapter) UpdateTracks(ctx context.Context, input mediaplane.UpdateTracksRequest) (mediaplane.TracksResponse, error) {
	path, err := sessionPath(input.ConnectionID, "tracks/update")
	if err != nil {
		return mediaplane.TracksResponse{}, err
	}
	operationID, err := newOperationID()
	if err != nil {
		return mediaplane.TracksResponse{}, fmt.Errorf("%w: operation id", mediaplane.ErrProviderFailed)
	}
	request := wireUpdateRequest{OperationID: operationID, Scope: wireScopeOf(input.Scope), Tracks: wireTracksOf(input.Tracks)}
	var response wireTracksResponse
	if err := a.call(ctx, path, request, &response); err != nil {
		return mediaplane.TracksResponse{}, err
	}
	return tracksResponseOf(input.ConnectionID, response), nil
}

func (a *Adapter) Renegotiate(ctx context.Context, input mediaplane.RenegotiateRequest) error {
	path, err := sessionPath(input.ConnectionID, "renegotiate")
	if err != nil {
		return err
	}
	operationID, err := newOperationID()
	if err != nil {
		return fmt.Errorf("%w: operation id", mediaplane.ErrProviderFailed)
	}
	request := wireRenegotiateRequest{
		OperationID:        operationID,
		Scope:              wireScopeOf(input.Scope),
		SessionDescription: wireDescription{SDP: input.SessionDescription.SDP, Type: input.SessionDescription.Type},
	}
	return a.call(ctx, path, request, nil)
}

// CloseTracks closes tracks by MID. A forced close of a session the SFU no longer
// holds counts as done, because cleanup only needs the tracks gone.
func (a *Adapter) CloseTracks(ctx context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	path, err := sessionPath(input.ConnectionID, "tracks/close")
	if err != nil {
		return mediaplane.CloseTracksResponse{}, err
	}
	operationID, err := newOperationID()
	if err != nil {
		return mediaplane.CloseTracksResponse{}, fmt.Errorf("%w: operation id", mediaplane.ErrProviderFailed)
	}
	closing := make([]wireCloseTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		closing = append(closing, wireCloseTrack{Mid: track.Mid})
	}
	request := wireCloseRequest{
		OperationID:        operationID,
		Scope:              wireScopeOf(input.Scope),
		Tracks:             closing,
		Force:              input.Force || input.ReceiveOnly,
		ReceiveOnly:        input.ReceiveOnly,
		SessionDescription: wireDescriptionOf(input.SessionDescription),
	}
	if input.ReceiveOnly {
		request.SessionDescription = nil
	}
	var response wireCloseResponse
	if err := a.call(ctx, path, request, &response); err != nil {
		if request.Force && errors.Is(err, mediaplane.ErrConnectionNotFound) {
			return mediaplane.CloseTracksResponse{AlreadyClosed: true, Tracks: input.Tracks}, nil
		}
		return mediaplane.CloseTracksResponse{}, err
	}
	alreadyClosed := len(response.Tracks) > 0
	for _, track := range response.Tracks {
		alreadyClosed = alreadyClosed && track.AlreadyClosed
	}
	return mediaplane.CloseTracksResponse{
		AlreadyClosed:      alreadyClosed,
		SessionDescription: descriptionOf(response.SessionDescription),
		Tracks:             input.Tracks,
	}, nil
}

// InspectSession reports a session's tracks. A gone session is a normal answer
// (Found false), not an error, because callers use it to decide cleanup.
func (a *Adapter) InspectSession(ctx context.Context, input mediaplane.InspectSessionRequest) (mediaplane.SessionState, error) {
	path, err := sessionPath(input.ConnectionID, "inspect")
	if err != nil {
		return mediaplane.SessionState{}, err
	}
	var response wireInspectResponse
	request := wireInspectRequest{Scope: wireScopeOf(input.Scope), Peer: input.Peer}
	if err := a.call(ctx, path, request, &response); err != nil {
		if errors.Is(err, mediaplane.ErrConnectionNotFound) {
			return mediaplane.SessionState{Found: false}, nil
		}
		return mediaplane.SessionState{}, err
	}
	tracks := make([]mediaplane.SessionTrack, 0, len(response.Tracks))
	for _, track := range response.Tracks {
		tracks = append(tracks, mediaplane.SessionTrack{Location: track.Location, Mid: track.Mid, TrackName: track.TrackName, Active: track.Active})
	}
	return mediaplane.SessionState{Found: true, Tracks: tracks}, nil
}

// SubscriptionStates reads how the SFU delivers each remote subscription of the
// caller's own session. A state or reason this adapter does not know fails the
// read, because the SDK would otherwise act on a guess.
func (a *Adapter) SubscriptionStates(ctx context.Context, input mediaplane.SubscriptionStatesRequest) ([]mediaplane.SubscriptionState, error) {
	path, err := sessionPath(input.ConnectionID, "inspect")
	if err != nil {
		return nil, err
	}
	var response wireInspectResponse
	if err := a.call(ctx, path, wireInspectRequest{Scope: wireScopeOf(input.Scope)}, &response); err != nil {
		return nil, err
	}
	states := make([]mediaplane.SubscriptionState, 0, len(response.Tracks))
	for _, track := range response.Tracks {
		if track.Location != "remote" || track.Subscription == nil {
			continue
		}
		state := track.Subscription
		if !knownSubscriptionState(state.State, state.Reason) {
			return nil, fmt.Errorf("%w: sfu subscription state %q reason %q", mediaplane.ErrProviderFailed, state.State, state.Reason)
		}
		states = append(states, mediaplane.SubscriptionState{
			Mid: track.Mid, SessionID: track.SessionID, TrackName: track.TrackName,
			State: state.State, Reason: state.Reason, Revision: state.Revision,
			RequestedRID: state.RequestedRID, EffectiveRID: state.EffectiveRID,
		})
	}
	return states, nil
}

func knownSubscriptionState(state, reason string) bool {
	switch state {
	case mediaplane.SubscriptionActive:
		return reason == ""
	case mediaplane.SubscriptionPaused:
		return reason == mediaplane.PauseCongestion || reason == mediaplane.PauseViewer || reason == mediaplane.PauseSourceInactive || reason == mediaplane.PauseSourceUnauthorized
	default:
		return false
	}
}

// RemoveParticipant is unsupported, as on Cloudflare: public-access removal gets
// a provider subject, not the SFU connection ID the remove route needs. Leaving
// the Episode closes the session through track cleanup and the Episode end.
func (a *Adapter) RemoveParticipant(context.Context, mediaplane.RemoveParticipantInput) error {
	return mediaplane.ErrUnsupportedOperation
}

func (a *Adapter) EndEpisode(ctx context.Context, input mediaplane.EndEpisodeInput) error {
	if input.Provider != mediaplane.ProviderChalkSFU {
		return mediaplane.ErrInvalidProvider
	}
	return a.call(ctx, "/v1/episodes/end", wireEndRequest{TenantID: input.TenantID, EpisodeID: input.EpisodeRef}, nil)
}

// maxSourceControls is the node's limit on one source control request.
const maxSourceControls = 64

// ControlSources sends grants and revokes in requests the node accepts. The node
// orders controls by revision, so a retry after an ambiguous failure is harmless.
// A revoke stops forwarding and closes the source's publications before the node
// answers.
func (a *Adapter) ControlSources(ctx context.Context, input mediaplane.ControlSourcesInput) ([]mediaplane.SourceControlResult, error) {
	results := make([]mediaplane.SourceControlResult, 0, len(input.Controls))
	for start := 0; start < len(input.Controls); start += maxSourceControls {
		batch := input.Controls[start:min(start+maxSourceControls, len(input.Controls))]
		request := wireSourceControlRequest{TenantID: input.TenantID, EpisodeID: input.EpisodeID, Controls: make([]wireSourceControl, len(batch))}
		for index, control := range batch {
			request.Controls[index] = wireSourceControl{ParticipantID: control.ParticipantID, Source: control.Source, Action: string(control.Action), Revision: control.Revision}
		}
		var response wireSourceControlResponse
		if err := a.call(ctx, "/v1/episodes/sources", request, &response); err != nil {
			return nil, err
		}
		if len(response.Results) != len(batch) {
			return nil, fmt.Errorf("%w: source control results do not match the request", mediaplane.ErrProviderFailed)
		}
		for index, result := range response.Results {
			closed := make([]mediaplane.ClosedSourceTrack, 0, len(result.Closed))
			for _, track := range result.Closed {
				closed = append(closed, mediaplane.ClosedSourceTrack{ConnectionID: track.SessionID, MID: track.Mid})
			}
			results = append(results, mediaplane.SourceControlResult{SourceControl: batch[index], Applied: result.Applied, Closed: closed})
		}
	}
	return results, nil
}

// EpisodeUsage reports no counters: the SFU does not meter usage yet.
func (a *Adapter) EpisodeUsage(_ context.Context, input mediaplane.EpisodeUsageInput) (mediaplane.Usage, error) {
	if input.Provider != mediaplane.ProviderChalkSFU {
		return mediaplane.Usage{}, mediaplane.ErrInvalidProvider
	}
	return mediaplane.Usage{Metadata: a.metadata()}, nil
}

func wireDescriptionOf(description *mediaplane.SessionDescription) *wireDescription {
	if description == nil {
		return nil
	}
	return &wireDescription{SDP: description.SDP, Type: description.Type}
}

func descriptionOf(description *wireDescription) *mediaplane.SessionDescription {
	if description == nil {
		return nil
	}
	return &mediaplane.SessionDescription{SDP: description.SDP, Type: description.Type}
}

func wireTracksOf(tracks []mediaplane.Track) []wireTrack {
	out := make([]wireTrack, 0, len(tracks))
	for _, track := range tracks {
		wired := wireTrack{Location: track.Location, Mid: track.Mid, TrackName: track.TrackName, SessionID: track.SessionID, Source: track.Source, Paused: track.Paused != nil && *track.Paused}
		if track.Simulcast != nil {
			wired.Simulcast = &wireSimulcast{PreferredRID: track.Simulcast.PreferredRID, PriorityOrdering: track.Simulcast.PriorityOrdering, RIDNotAvailable: track.Simulcast.RIDNotAvailable}
		}
		out = append(out, wired)
	}
	return out
}

func tracksResponseOf(connectionID string, response wireTracksResponse) mediaplane.TracksResponse {
	out := mediaplane.TracksResponse{
		SessionDescription:             descriptionOf(response.SessionDescription),
		RequiresImmediateRenegotiation: response.RequiresImmediateRenegotiation,
	}
	for _, track := range response.Tracks {
		out.Tracks = append(out.Tracks, mediaplane.Track{Location: track.Location, Mid: track.Mid, TrackName: track.TrackName, SessionID: track.SessionID, Source: track.Source})
	}
	for _, failed := range response.TrackErrors {
		// A pull error names the publisher's connection, as Cloudflare's does, so
		// clients match it to the publication they asked for. A push error names none.
		owner := failed.SessionID
		if owner == "" {
			owner = connectionID
		}
		out.TrackErrors = append(out.TrackErrors, mediaplane.TrackError{ConnectionID: owner, TrackName: failed.TrackName, Code: failed.Code, PublicationMissing: failed.Code == "track_not_found"})
	}
	return out
}

func iceServersOf(urls []string) []mediaplane.ICEServer {
	if len(urls) == 0 {
		return []mediaplane.ICEServer{}
	}
	return []mediaplane.ICEServer{{URLs: urls}}
}
