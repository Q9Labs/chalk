package media

import (
	"cmp"
	"log/slog"
	"maps"
	"slices"
	"time"
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
			pub.session.trail(slog.LevelInfo, EventCameraPlan, "level", planName(camera.level), "was", planName(pub.plan), "ceiling_packets", int(ceiling))
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
