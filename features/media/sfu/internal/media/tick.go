package media

import (
	"maps"
	"math"
	"slices"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

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

	stats := &mediaStats{episodes: make(map[episodeKey]protocol.EpisodeState, len(sessions))}
	episodes := n.sample(sessions, stats, now)
	for key, episode := range episodes {
		n.plan(key, episode, now)
		for _, session := range episode.sessions {
			allocateSession(session, episode.room, &probes, now)
		}
		n.applyLimits(episode, stats, now)
		episode.state.PacketsPerSecond = math.Round(episode.measured)
		stats.episodes[key] = episode.state
		stats.packets += episode.measured
	}
	maps.DeleteFunc(n.plans, func(key episodeKey, _ int64) bool { return episodes[key] == nil })
	stats.totals = n.totals
	n.stats.Store(stats)
}

// sample reads every meter once and groups the participant sessions by Episode. A capture
// session counts toward the node only.
func (n *Node) sample(sessions []*Session, stats *mediaStats, now int64) map[episodeKey]*episodeTick {
	episodes := map[episodeKey]*episodeTick{}
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
		n.sampleSession(session, episode, stats, now)
	}
	return episodes
}

func (n *Node) sampleSession(session *Session, episode *episodeTick, stats *mediaStats, now int64) {
	published, subscribed := session.media()
	episode.sessions = append(episode.sessions, session)
	episode.subscriptions = append(episode.subscriptions, subscribed...)
	for _, pub := range published {
		n.sampleIngress(pub, episode, stats, now)
	}
	for class, pps := range n.sampleEgress(session, stats, now) {
		episode.addEgress(packetClass(class), pps)
		switch packetClass(class) {
		case classRepair:
			stats.repair += pps
		case classProbe:
			stats.probe += pps
		}
	}
}

// sampleIngress counts a publication's layers in the node's totals and in its Episode's base.
func (n *Node) sampleIngress(pub *publication, episode *episodeTick, stats *mediaStats, now int64) {
	kind := ingressAudio
	if pub.video() {
		kind = ingressVideo
	}
	for index := range pub.layers {
		layer := pub.layers[index].Load()
		if layer == nil {
			continue
		}
		n.tallyIngress(kind, layer, now)
		pps, bps := layer.meter.rates()
		stats.in[kind].add(pps, bps)
		episode.base += pps
		episode.measured += pps
	}
}

// sampleEgress counts a session's transport in the node's totals and returns its packets/s per class.
func (n *Node) sampleEgress(session *Session, stats *mediaStats, now int64) (rates [packetClasses]float64) {
	n.tallyEgress(session.transport.tick(now))
	for class := range packetClasses {
		pps, bps := session.transport.meters[class].rates()
		stats.out[class].add(pps, bps)
		rates[class] = pps
	}
	return rates
}

// applyLimits sets every subscription's server limit from its transport's allocation capped by
// the Episode plan, and counts the video the downlink or the plan pauses.
func (n *Node) applyLimits(episode *episodeTick, stats *mediaStats, now int64) {
	for _, subscription := range episode.subscriptions {
		link := subscription.alloc.limit()
		video := subscription.pub.video()
		if !video {
			link = serverLimit{}
		}
		limit := link.capped(subscription.pub.plan)
		subscription.setServerLimit(limit)
		if !video {
			continue
		}
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

// tallyCapture counts a capture session's egress in the node's totals and leaves it out of its
// Episode. The Episode's plan, packet ceiling and probes serve the call, so a recording neither
// lowers a camera for the Participants nor gets lowered itself: its subscriptions keep the layer
// they asked for. Its packets still count against the node, which reserves them at admission.
func (n *Node) tallyCapture(session *Session, stats *mediaStats, now int64) {
	for _, pps := range n.sampleEgress(session, stats, now) {
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
	n.log.Info(message, append(scopeAttrs(s.owner.scope), "event", EventSubscriptionCongestion, "connection_id", s.owner.id, "mid", s.mid, "rid", s.alloc.rid, "layer", layerLabel(s.alloc.rid), "reason", reason,
		"estimate_bps", math.Round(reading.current), "proven_bps", math.Round(reading.proven),
		"delivered_share", round2(reading.delivered), "probing", reading.probing, "host_pressure", reading.pressured,
		"acked_bps", math.Round(reading.acked), "loss_share", round2(reading.lossShare), "lossy", reading.lossy,
		"trend", reading.trend.String(), "decrease_cause", reading.decrease.cause, "decrease_ago_ms", reading.decrease.agoMs(now),
		"decrease_from_bps", math.Round(reading.decrease.from), "decrease_to_bps", math.Round(reading.decrease.to), "decrease_acked_bps", math.Round(reading.decrease.acked))...)
}
