package media

// episodeRecord is what the node keeps for one Episode: its live sessions of every kind, the hold
// that reserved it ahead of its joins, and the session sharing its screen. Everything the node
// asks about one Episode reads its record instead of scanning every session. A record exists only
// while it holds something, so the table is bounded by the sessions and holds the node already
// bounds. The retirement floor, the source authorities and the allocator's plan stay apart: they
// outlive the Episode's sessions, or only the control loop reads them. n.mu guards every record.
type episodeRecord struct {
	sessions map[*Session]struct{}
	hold     *episodeHold
	screen   *Session
}

// record finds the Episode's record, or makes it. A caller that leaves the record empty calls tidy.
func (n *Node) record(key episodeKey) *episodeRecord {
	rec := n.episodes[key]
	if rec == nil {
		rec = &episodeRecord{sessions: map[*Session]struct{}{}}
		n.episodes[key] = rec
	}
	return rec
}

// tidy drops the Episode's record once it holds nothing.
func (n *Node) tidy(key episodeKey) {
	if rec := n.episodes[key]; rec != nil && len(rec.sessions) == 0 && rec.hold == nil && rec.screen == nil {
		delete(n.episodes, key)
	}
}

func (n *Node) enter(s *Session) {
	n.sessions[s.id] = s
	n.record(episodeOf(s.scope)).sessions[s] = struct{}{}
}

func (n *Node) leave(s *Session) {
	key := episodeOf(s.scope)
	delete(n.sessions, s.id)
	if rec := n.episodes[key]; rec != nil {
		delete(rec.sessions, s)
		n.tidy(key)
	}
}

// holdOf is the Episode's hold, or nil.
func (n *Node) holdOf(key episodeKey) *episodeHold {
	if rec := n.episodes[key]; rec != nil {
		return rec.hold
	}
	return nil
}

func (n *Node) setHold(key episodeKey, hold *episodeHold) { n.record(key).hold = hold }

func (n *Node) clearHold(key episodeKey) {
	if rec := n.episodes[key]; rec != nil {
		rec.hold = nil
		n.tidy(key)
	}
}

// heldEpisodes counts the Episodes with a hold.
func (n *Node) heldEpisodes() int {
	held := 0
	for _, rec := range n.episodes {
		if rec.hold != nil {
			held++
		}
	}
	return held
}

// screenOf is the session sharing a screen in the Episode, or nil.
func (n *Node) screenOf(key episodeKey) *Session {
	if rec := n.episodes[key]; rec != nil {
		return rec.screen
	}
	return nil
}

// The methods below read a record that may be nil: an Episode with no record has no sessions.

// count is the Episode's live sessions that are Participants or captures, leaving out one that is
// about to be replaced and any session of an allocation below from.
func (r *episodeRecord) count(participants bool, replacing *Session, from int64) int {
	if r == nil {
		return 0
	}
	count := 0
	for s := range r.sessions {
		if s.kind.participant == participants && s != replacing && s.allocation >= from {
			count++
		}
	}
	return count
}

// hosts reports whether a live Participant session belongs to the Episode. A capture does not
// host one.
func (r *episodeRecord) hosts() bool { return r.count(true, nil, 0) > 0 }

// captureReserved is what the Episode's live capture sessions reserve for their subscriptions,
// leaving out one that is about to be replaced.
func (r *episodeRecord) captureReserved(leaving *Session) int {
	if r == nil {
		return 0
	}
	reserved := 0
	for s := range r.sessions {
		if !s.kind.participant && s != leaving {
			reserved += s.captureReserved
		}
	}
	return reserved
}

// list copies the Episode's sessions.
func (r *episodeRecord) list() []*Session {
	if r == nil {
		return nil
	}
	sessions := make([]*Session, 0, len(r.sessions))
	for s := range r.sessions {
		sessions = append(sessions, s)
	}
	return sessions
}
