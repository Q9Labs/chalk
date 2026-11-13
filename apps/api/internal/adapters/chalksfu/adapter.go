// Package chalksfu is the media-plane adapter for Chalk's own SFU. It speaks the
// SFU's mutual-TLS control API and keeps no state of its own: every mutation
// carries an operation ID that stays the same across this adapter's HTTP retries,
// so the SFU runs it once.
package chalksfu

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
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
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

var ErrMissingConfig = errors.New("missing chalk sfu config")

// Adapter is the media plane of one SFU node. Fleet builds one per configured node.
type Adapter struct {
	node          string
	base          *url.URL
	client        *http.Client
	applicationID string
	iceServers    []mediaplane.ICEServer
	// unifiedSignaling is advertised in each join so the SDK uses the single signalling URL.
	unifiedSignaling bool
	// directSignalingURL is advertised in each join when set; empty leaves the field out.
	directSignalingURL string
	relay              RelaySource
	backoff            time.Duration
	captureReplay      *captureplane.ReplayCache
	// incarnation is the boot incarnation the Episode was bound to, set by Bound. When set, a
	// join the node answers for another incarnation is refused as stale.
	incarnation string
	// allocation is the binding generation the adapter was issued under, set by Bound. Sent with
	// creates and source controls, it lets the node refuse a retired allocation.
	allocation *int64
	// fence, when set, re-reads the Episode's durable binding after a join and fails when it is
	// no longer the one the join was issued under. See WithFence.
	fence func(context.Context) error
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

func newAdapter(config runtimeconfig.ChalkSFUConfig, node runtimeconfig.ChalkSFUNode, client *http.Client) (*Adapter, error) {
	base, err := url.Parse(strings.TrimSpace(node.ControlURL))
	if err != nil || base.Scheme != "https" || base.Host == "" {
		return nil, fmt.Errorf("%w: node %q control URL must be https", ErrMissingConfig, node.ID)
	}
	if !mediaplane.ValidNodeID(node.ID) {
		return nil, fmt.Errorf("%w: node ID %q", ErrMissingConfig, node.ID)
	}
	return &Adapter{
		node:               node.ID,
		base:               base,
		client:             client,
		applicationID:      config.ApplicationID,
		iceServers:         iceServersOf(config.STUNURLs),
		unifiedSignaling:   config.UnifiedSignaling,
		directSignalingURL: config.DirectSignalingURL,
		backoff:            retryBackoff,
		captureReplay:      captureplane.NewReplayCache(captureReplayCapacity),
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

func (a *Adapter) EnsureEpisode(_ context.Context, input mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	if input.Provider != mediaplane.ProviderChalkSFU {
		return mediaplane.Episode{}, mediaplane.ErrInvalidProvider
	}
	return mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: input.EpisodeKey, Metadata: a.metadata()}, nil
}

func (a *Adapter) metadata() map[string]string {
	return map[string]string{"application_id": a.applicationID}
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
		request := wireSourceControlRequest{TenantID: input.TenantID, EpisodeID: input.EpisodeID, AllocationGeneration: a.allocation, Controls: make([]wireSourceControl, len(batch))}
		for index, control := range batch {
			request.Controls[index] = wireSourceControl{ParticipantID: control.ParticipantID, Source: string(control.Source), Action: string(control.Action), Revision: control.Revision}
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
