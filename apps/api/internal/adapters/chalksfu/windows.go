package chalksfu

import (
	"context"
	"fmt"
	"net/netip"
	"slices"
	"time"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/sfufleet"
)

const windowControlPort = 8443

type WindowDirectory func(context.Context) ([]sfufleet.Route, error)

type windowAdapter struct {
	sfufleet.Route
	adapter *Adapter
	addedAt time.Time
}

// LoadWindowNodes configures the directory before the fleet starts probing.
func (f *Fleet) LoadWindowNodes(directory WindowDirectory) {
	f.loadWindows = directory
}

func (f *Fleet) refreshWindows(ctx context.Context) {
	if f.loadWindows == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	entries, err := f.loadWindows(ctx)
	if err == nil {
		err = f.replaceWindows(entries)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err != nil && !f.directoryFailed && ctx.Err() != context.Canceled && f.log != nil {
		f.log.WarnContext(ctx, "chalk sfu window directory unavailable", "err", err)
	}
	f.directoryFailed = err != nil
}

func (f *Fleet) replaceWindows(entries []sfufleet.Route) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	next := make([]windowAdapter, 0, len(entries))
	for _, entry := range entries {
		if !mediaplane.IsWindowNode(entry.ID) || !entry.Address.Is4() ||
			slices.ContainsFunc(next, func(item windowAdapter) bool { return item.ID == entry.ID }) {
			return fmt.Errorf("invalid window node directory entry")
		}
		index := slices.IndexFunc(f.windows, func(item windowAdapter) bool { return item.ID == entry.ID })
		if index >= 0 {
			existing := f.windows[index]
			if existing.Address != entry.Address {
				return fmt.Errorf("window node control address changed")
			}
			next = append(next, windowAdapter{entry, existing.adapter, existing.addedAt})
			continue
		}
		node := runtimeconfig.ChalkSFUNode{ID: entry.ID, ControlURL: "https://" + netip.AddrPortFrom(entry.Address, windowControlPort).String()}
		adapter, err := newAdapter(f.config, node, f.client)
		if err != nil {
			return err
		}
		next = append(next, windowAdapter{entry, adapter, time.Now()})
	}
	for _, old := range f.windows {
		if !slices.ContainsFunc(next, func(item windowAdapter) bool { return item.ID == old.ID }) {
			delete(f.loads, old.ID)
			delete(f.seen, old.ID)
			delete(f.verdicts, old.ID)
			delete(f.inflight, old.ID)
		}
	}
	f.windows = next
	f.rebuildPlacement()
	return nil
}

func (f *Fleet) nodeLocked(id string) *Adapter {
	for _, node := range f.nodes {
		if node.node == id {
			return node
		}
	}
	for _, window := range f.windows {
		if window.ID == id {
			return window.adapter
		}
	}
	return nil
}

func (f *Fleet) rebuildPlacement() {
	f.placementOrder = f.placementOrder[:0]
	for _, node := range f.nodes {
		if !f.standbys[node.node] {
			f.placementOrder = append(f.placementOrder, node)
		}
	}
	for _, window := range f.windows {
		if window.Accepting {
			f.placementOrder = append(f.placementOrder, window.adapter)
		}
	}
	for _, node := range f.nodes {
		if f.standbys[node.node] {
			f.placementOrder = append(f.placementOrder, node)
		}
	}
}
