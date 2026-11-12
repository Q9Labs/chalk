package media

import (
	"cmp"
	"log/slog"
	"maps"
	"math"
	"slices"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// An Episode stays under its packet ceiling, the lower of its reservation, the
// configured Episode ceiling and the node budget, counting ingress, egress and
// repair. Audio and the screen share are mandatory; admission already refused
// any shape whose mandatory media exceeds the ceiling. The plan lowers camera
// video instead, the least recent speaker first: first every camera to its
// lowest layer, then pauses them, until the prediction fits. It raises one step
// at a time, the most recent speaker first, only after a hold and only into
// room below the ceiling.
const (
	planOpen   uint8 = iota // subscribers get what their transports allow
	planLowest              // subscribers are capped at the camera's lowest active layer
	planPaused              // the camera's video is paused for every subscriber
	planLevels
)

const (
	planRaiseShare = 0.9
	planRaiseHold  = 2 * time.Second
)

// plannedCamera is one camera publication in its Episode's plan.
type plannedCamera struct {
	voiced int64 // the publisher's latest speech, monotonic, or 0
	order  uint64
	level  uint8
	cost   [planLevels]float64 // packets/s the camera's subscribers take at each level
}

// planEpisode moves the cameras' levels so the prediction, base plus every
// camera's cost at its level, fits the ceiling. It reports whether a level changed.
func planEpisode(cameras []*plannedCamera, base, ceiling float64, mayRaise bool) bool {
	slices.SortFunc(cameras, func(a, b *plannedCamera) int {
		if a.voiced != b.voiced {
			return cmp.Compare(a.voiced, b.voiced)
		}
		return cmp.Compare(a.order, b.order)
	})
	predicted := func() float64 {
		total := base
		for _, camera := range cameras {
			total += camera.cost[camera.level]
		}
		return total
	}
	if predicted() > ceiling {
		changed := false
		for level := planLowest; level <= planPaused; level++ {
			for _, camera := range cameras {
				if predicted() <= ceiling {
					return changed
				}
				if camera.level < level {
					camera.level, changed = level, true
				}
			}
		}
		return changed
	}
	if !mayRaise {
		return false
	}
	// The reverse of lowering: paused cameras return before capped ones rise.
	for level := planPaused; level >= planLowest; level-- {
		for index := len(cameras) - 1; index >= 0; index-- {
			camera := cameras[index]
			if camera.level != level {
				continue
			}
			camera.level--
			if predicted() <= planRaiseShare*ceiling {
				return true
			}
			camera.level++
			return false
		}
	}
	return false
}

// episodeTick is one Episode as the control loop sees it during one tick.
type episodeTick struct {
	sessions      []*Session
	subscriptions []*subscription
	base          float64 // packets/s the plan cannot lower
	cameras       map[*publication]*plannedCamera
	room          bool    // the Episode can afford a probe
	measured      float64 // packets/s its publishers and transports sent in the last second
	probing       float64 // packets/s of probe padding its transports sent, which counts toward room only
	state         protocol.EpisodeState
}

// addEgress counts one transport's packets/s of a class. Repairs join the base the plan cannot
// lower. A probe does not: it is the allocator's own 400 ms of padding, and lowering cameras to
// make room for a measurement would freeze video at every join. It still takes room, so the
// Episode starts no further probe while its probes and video fill the ceiling.
func (e *episodeTick) addEgress(class packetClass, pps float64) {
	e.measured += pps
	switch class {
	case classRepair:
		e.base += pps
	case classProbe:
		e.probing += pps
	}
}

// mediaStats is the control loop's latest view of the node's media, published
// for inspection and telemetry after every tick.
type mediaStats struct {
	episodes map[episodeKey]protocol.EpisodeState
	packets  float64 // every Episode's measured packets/s
	repair   float64 // retransmitted packets/s across subscriber transports
	probe    float64
	// congested counts video subscriptions their own downlink pauses; plannerPaused those an
	// Episode plan pauses to hold its packet ceiling, however good the downlink is.
	congested, plannerPaused int
	// in and out are the node's media rates over the last second; totals its counts since start.
	in     [ingressKinds]flowRate
	out    [packetClasses]flowRate
	totals nodeTotals
}

type flowRate struct{ pps, bps float64 }

func (r *flowRate) add(pps, bps float64) {
	r.pps += pps
	r.bps += bps
}

// allocate runs one control tick. It samples every meter, plans each Episode
// under its packet ceiling, spends each subscriber transport's estimate within
// that plan, and applies the resulting limits. Only the control loop calls it.
func (n *Node) allocate() {
	now := monotonic()
	n.mu.Lock()
	sessions := slices.Collect(maps.Values(n.sessions))
	n.mu.Unlock()
	if from, stalled := n.pressure.controlTick(now); stalled {
		n.log.Warn("control loop stalled", "stallMs", time.Duration(now-from).Milliseconds())
	}
	probes := n.shareHostState(sessions, now)

	episodes := map[episodeKey]*episodeTick{}
	stats := &mediaStats{episodes: make(map[episodeKey]protocol.EpisodeState, len(sessions))}
	for _, session := range sessions {
		if !session.kind.participant {
			n.tallyCapture(session, stats, now)
			continue
		}
		key := episodeOf(session.scope)
		episode := episodes[key]
		if episode == nil {
			episode = &episodeTick{cameras: map[*publication]*plannedCamera{}}
			episodes[key] = episode
		}
		published, subscribed := session.media()
		episode.sessions = append(episode.sessions, session)
		episode.subscriptions = append(episode.subscriptions, subscribed...)
		for _, pub := range published {
			kind := ingressAudio
			if pub.video() {
				kind = ingressVideo
			}
			for index := range pub.layers {
				if layer := pub.layers[index].Load(); layer != nil {
					n.tallyIngress(kind, layer, now)
					pps, bps := layer.meter.rates()
					stats.in[kind].add(pps, bps)
					episode.base += pps
					episode.measured += pps
				}
			}
		}
		n.tallyEgress(session.transport.tick(now))
		for class := range packetClasses {
			pps, bps := session.transport.meters[class].rates()
			stats.out[class].add(pps, bps)
			episode.addEgress(class, pps)
			switch class {
			case classRepair:
				stats.repair += pps
			case classProbe:
				stats.probe += pps
			}
		}
	}

	for key, episode := range episodes {
		n.plan(key, episode, now)
		for _, session := range episode.sessions {
			allocateSession(session, episode.room, &probes, now)
		}
		for _, subscription := range episode.subscriptions {
			link := subscription.alloc.limit()
			if !subscription.pub.video() {
				link = serverLimit{}
			}
			limit := link.capped(subscription.pub.plan)
			subscription.setServerLimit(limit)
			if subscription.pub.video() {
				n.totals.counts.LayerSwitches += subscription.takeSwitches()
				n.logCongestionPause(subscription, link.paused, now)
				switch {
				case link.paused:
					stats.congested++
				case limit.paused:
					stats.plannerPaused++
				}
			}
		}
		episode.state.PacketsPerSecond = math.Round(episode.measured)
		stats.episodes[key] = episode.state
		stats.packets += episode.measured
	}
	maps.DeleteFunc(n.plans, func(key episodeKey, _ int64) bool { return episodes[key] == nil })
	stats.totals = n.totals
	n.stats.Store(stats)
}

// tallyCapture counts a capture session's egress in the node's totals and leaves it out of its
// Episode. The Episode's plan, packet ceiling and probes serve the call, so a recording neither
// lowers a camera for the Participants nor gets lowered itself: its subscriptions keep the layer
// they asked for. Its packets still count against the node, which reserves them at admission.
func (n *Node) tallyCapture(session *Session, stats *mediaStats, now int64) {
	n.tallyEgress(session.transport.tick(now))
	for class := range packetClasses {
		pps, bps := session.transport.meters[class].rates()
		stats.out[class].add(pps, bps)
		stats.packets += pps
	}
}

// shareHostState tells every transport whether the node is under pressure, before
// any of them settles feedback or a probe, and returns the probe slots left after
// the probes already running. Receivers that go quiet together raise the pressure.
func (n *Node) shareHostState(sessions []*Session, now int64) probeBudget {
	until := n.pressure.end(now)
	budget := probeBudget{slots: maxProbes}
	for _, session := range sessions {
		if until != 0 {
			session.transport.pressure(until)
		}
		if session.transport.probing() {
			budget.slots--
		}
	}
	return budget
}

// logCongestionPause logs a subscription's congestion pause when it starts and
// when it ends, with the estimate that decided it and the evidence behind that
// estimate: what the receiver acknowledged, the latest loss window, the delay
// trend and the cause of the latest decrease. It carries the subscriber's ids and no address.
func (n *Node) logCongestionPause(s *subscription, paused bool, now int64) {
	if paused == s.pauseLogged {
		return
	}
	s.pauseLogged = paused
	reading := s.transport.reading(now)
	message := "subscription resumed after a congestion pause"
	reason := "bandwidth_recovered"
	if paused {
		message = "subscription paused for congestion"
		reason = "insufficient_bandwidth"
	}
	n.log.Info(message, append(scopeAttrs(s.owner.scope), "event", "sfu.subscription.congestion", "connection_id", s.owner.id, "connectionId", s.owner.id, "mid", s.mid, "rid", s.alloc.rid, "layer", layerLabel(s.alloc.rid), "reason", reason,
		"estimateBps", math.Round(reading.current), "provenBps", math.Round(reading.proven),
		"deliveredShare", round2(reading.delivered), "probing", reading.probing, "hostPressure", reading.pressured,
		"ackedBps", math.Round(reading.acked), "lossShare", round2(reading.lossShare), "lossy", reading.lossy,
		"trend", reading.trend.String(), "decreaseCause", reading.decrease.cause, "decreaseAgoMs", reading.decrease.agoMs(now),
		"decreaseFromBps", math.Round(reading.decrease.from), "decreaseToBps", math.Round(reading.decrease.to), "decreaseAckedBps", math.Round(reading.decrease.acked))...)
}

// plan predicts the Episode's packets/s from what its publishers send and
// what each subscriber is allowed, and moves its camera levels to fit.
func (n *Node) plan(key episodeKey, episode *episodeTick, now int64) {
	for _, subscription := range episode.subscriptions {
		pub := subscription.pub
		limit := subscription.alloc.limit()
		if !pub.video() || pub.source == sourceScreen {
			if !pub.video() {
				limit = serverLimit{}
			}
			episode.base += subscription.packetRate(limit, now)
			continue
		}
		camera := episode.cameras[pub]
		if camera == nil {
			camera = &plannedCamera{voiced: pub.session.lastVoiced.Load(), order: pub.order, level: pub.plan}
			episode.cameras[pub] = camera
		}
		for level := range planLevels {
			camera.cost[level] += subscription.packetRate(limit.capped(level), now)
		}
	}
	cameras := slices.Collect(maps.Values(episode.cameras))
	ceiling := float64(n.episodeReservation(len(episode.sessions)))
	lastChange, seen := n.plans[key]
	if !seen {
		n.plans[key] = now
	}
	if planEpisode(cameras, episode.base, ceiling, seen && now-lastChange >= int64(planRaiseHold)) {
		n.plans[key] = now
	}
	predicted := episode.base
	episode.state.CeilingPackets = int(ceiling)
	for pub, camera := range episode.cameras {
		if pub.plan != camera.level {
			pub.session.trail(slog.LevelInfo, "sfu.camera.plan", "level", planName(camera.level), "was", planName(pub.plan), "ceiling_packets", int(ceiling))
		}
		pub.plan = camera.level
		predicted += camera.cost[camera.level]
		switch camera.level {
		case planLowest:
			episode.state.CappedCameras++
		case planPaused:
			episode.state.PausedCameras++
		}
	}
	episode.room = predicted+episode.probing <= planRaiseShare*ceiling
}

// packetRate is the packets/s this subscription would forward under limit. A
// source whose lease is closed forwards nothing, though its ingress still counts.
func (s *subscription) packetRate(limit serverLimit, now int64) float64 {
	request := s.currentRequest()
	if request.paused || limit.paused || !s.pub.authority.allows(now, now) {
		return 0
	}
	views := s.pub.views(now)
	layer := s.pub.layer(pickLayer(request, limit.rid, views[:]))
	if layer == nil {
		return 0
	}
	pps, _ := layer.meter.rates()
	return pps
}

// allocateSession spends one subscriber transport's estimate on its video. A
// subscriber without transport-wide feedback gets no bandwidth limit, as
// before the allocator, and its Episode's plan alone applies. A source whose
// lease is closed gets no share until a grant opens it.
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
		if binding.twccID == 0 {
			subscription.alloc = allocation{decided: true}
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
