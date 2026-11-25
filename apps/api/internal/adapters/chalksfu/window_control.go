package chalksfu

import (
	"context"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"

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
	if ready.Draining == nil || ready.Allocations == nil || ready.CleanupDebt == nil ||
		!mediaplane.ValidIncarnation(ready.NodeIncarnation) || *ready.Allocations < 0 || *ready.CleanupDebt < 0 ||
		status == http.StatusServiceUnavailable && !*ready.Draining {
		return sfufleet.Health{}, fmt.Errorf("invalid SFU window health")
	}
	return sfufleet.Health{
		Incarnation: ready.NodeIncarnation,
		Admission: ready.Protocol >= minNodeProtocol && ready.Revision == c.revision &&
			ready.PacketBudget >= 36000 && ready.Host.AdmissionReason == "",
		Draining: *ready.Draining, Allocations: *ready.Allocations, CleanupDebt: *ready.CleanupDebt,
	}, nil
}

func (c WindowControl) SetDrain(ctx context.Context, address netip.Addr, draining bool) error {
	route := protocol.RouteUndrain
	if draining {
		route = protocol.RouteDrain
	}
	var state protocol.DrainState
	if err := c.adapter(address).call(ctx, route, nil, &state); err != nil {
		return err
	}
	if state.Draining != draining {
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
