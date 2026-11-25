package chalksfu

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/sfufleet"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

type WindowControl struct {
	client   *http.Client
	revision string
}

func NewWindowControl(config config.ChalkSFUConfig, revision string) (WindowControl, error) {
	if boundedRevision(revision) == "" {
		return WindowControl{}, fmt.Errorf("SFU window control requires a build revision")
	}
	client, err := newClient(config)
	return WindowControl{client: client, revision: revision}, err
}

func (c WindowControl) Observe(ctx context.Context, address netip.Addr) (sfufleet.Health, error) {
	// Absence is not an empty node; require all drain fields on the wire.
	var ready struct {
		protocol.ReadyResponse
		Draining    *bool `json:"draining"`
		Allocations *int  `json:"allocations"`
		CleanupDebt *int  `json:"cleanupDebt"`
	}
	status, err := c.adapter(address).readReady(ctx, &ready)
	if err != nil {
		return sfufleet.Health{}, fmt.Errorf("read SFU window health: %s", mediaplane.ClassifyTransportCause(ctx, err))
	}
	if !ready.DrainIfMatch || ready.Draining == nil || ready.Allocations == nil || ready.CleanupDebt == nil ||
		!mediaplane.ValidIncarnation(ready.NodeIncarnation) || *ready.Allocations < 0 || *ready.CleanupDebt < 0 ||
		status == http.StatusServiceUnavailable && !*ready.Draining {
		return sfufleet.Health{}, fmt.Errorf("invalid SFU window health")
	}
	compatible := ready.Protocol >= minNodeProtocol && ready.Revision == c.revision && ready.PacketBudget >= 36000
	return sfufleet.Health{
		Incarnation:  ready.NodeIncarnation,
		Admission:    compatible && ready.Host.AdmissionReason == "",
		Incompatible: !compatible,
		Draining:     *ready.Draining, Allocations: *ready.Allocations, CleanupDebt: *ready.CleanupDebt,
	}, nil
}

func (c WindowControl) SetDrain(ctx context.Context, address netip.Addr, incarnation string, draining bool) error {
	route := protocol.RouteUndrainFenced
	if draining {
		route = protocol.RouteDrainFenced
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.adapter(address).base.JoinPath(route).String(), nil)
	if err != nil {
		return err
	}
	request.Header.Set("If-Match", strconv.Quote(incarnation))
	reply, err := c.client.Do(request)
	if err != nil {
		return fmt.Errorf("set SFU window drain: %s", mediaplane.ClassifyTransportCause(ctx, err))
	}
	defer reply.Body.Close()
	if reply.StatusCode != http.StatusOK {
		return fmt.Errorf("SFU window drain status %d", reply.StatusCode)
	}
	var state struct {
		Draining *bool `json:"draining"`
	}
	if err := json.NewDecoder(io.LimitReader(reply.Body, maxResponseBytes)).Decode(&state); err != nil || state.Draining == nil || *state.Draining != draining {
		return fmt.Errorf("SFU window control did not confirm the drain state")
	}
	return nil
}

func (c WindowControl) adapter(address netip.Addr) *Adapter {
	return &Adapter{
		base:    &url.URL{Scheme: "https", Host: netip.AddrPortFrom(address, windowControlPort).String()},
		client:  c.client,
		backoff: retryBackoff,
	}
}
