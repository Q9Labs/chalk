package media

import (
	"cmp"
	"slices"
)

// allocateSession spends one subscriber transport's estimate on its video. A
// subscriber without transport-wide feedback spends the ceiling its receiver
// reports allow. A source whose lease is closed gets no share until a grant opens it.
func allocateSession(session *Session, room bool, probes *probeBudget, now int64) {
	transport := session.transport
	estimate := transport.estimate(now)
	_, audio := transport.meters[classAudio].rates()
	_, repair := transport.meters[classRepair].rates()
	_, subscribed := session.media()
	tiles := make([]tile, 0, len(subscribed))
	for _, subscription := range subscribed {
		pub := subscription.pub
		binding := subscription.track.binding.Load()
		if !pub.video() || binding == nil {
			continue
		}
		request := subscription.currentRequest()
		if request.paused || pub.plan == planPaused || !pub.authority.allows(now, now) {
			continue
		}
		tiles = append(tiles, tile{
			screen: pub.source == sourceScreen, voiced: pub.session.lastVoiced.Load(), order: subscription.order,
			layers: subscription.allocatable(request, now), state: &subscription.alloc,
		})
	}
	if target := allocate(tiles, estimate, audio, repair, now); target > 0 && room && estimate.probeReady && probes.take() {
		transport.probe(target, now)
	}
}

// allocatable lists the active layers within the request's ceiling and the
// Episode plan, best first, with what each one sends.
func (s *subscription) allocatable(request layerRequest, now int64) []layerRate {
	var layers []layerRate
	for index := range s.pub.layers {
		layer := s.pub.layers[index].Load()
		if layer == nil || !layer.active(now) || (layer.rid != "" && layer.rid < request.wanted()) {
			continue
		}
		_, bps := layer.meter.rates()
		if bps == 0 {
			bps = nominalRate(s.pub.source, layer.rid)
		}
		layers = append(layers, layerRate{rid: layer.rid, bps: bps})
	}
	slices.SortFunc(layers, func(a, b layerRate) int { return cmp.Compare(a.rid, b.rid) })
	// Without fallback a missing requested layer sends nothing, so it costs nothing.
	if !request.fallback && len(layers) > 0 && layers[0].rid != "" && layers[0].rid != request.wanted() {
		return nil
	}
	if s.pub.plan == planLowest && len(layers) > 1 {
		layers = layers[len(layers)-1:]
	}
	return layers
}

// nominalRate is what a layer is assumed to send before its meter has a reading.
func nominalRate(source, rid string) float64 {
	switch {
	case source == sourceScreen:
		return 2_000_000
	case rid == "h":
		return 1_500_000
	case rid == "":
		return 800_000
	}
	return 650_000
}
