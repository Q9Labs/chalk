package websocket

import (
	"encoding/json"
	"sync"
	"time"
)

type PubSubDelivery string

const (
	PubSubReliable PubSubDelivery = "reliable"
	PubSubVolatile PubSubDelivery = "volatile"
)

// PubSubEnvelope wraps a WebSocket message for cross-instance fanout.
// Data is embedded as JSON (no base64) so we can broadcast it directly as WS text.
type PubSubEnvelope struct {
	MessageID            string          `json:"message_id"`
	OriginInstanceID     string          `json:"origin_instance_id"`
	RoomID               string          `json:"room_id"`
	ExcludeParticipantID string          `json:"exclude_participant_id,omitempty"`
	Delivery             PubSubDelivery  `json:"delivery"`
	Data                 json.RawMessage `json:"data"`
}

type pubsubDedupe struct {
	mu  sync.Mutex
	ttl time.Duration
	max int
	// message_id -> unix millis first seen
	seen map[string]int64
}

func newPubsubDedupe(ttl time.Duration, max int) *pubsubDedupe {
	return &pubsubDedupe{
		ttl:  ttl,
		max:  max,
		seen: make(map[string]int64),
	}
}

// ShouldProcess returns true if messageID has not been seen recently.
func (d *pubsubDedupe) ShouldProcess(messageID string) bool {
	if messageID == "" {
		return true
	}

	now := time.Now()
	nowMs := now.UnixMilli()
	cutoffMs := now.Add(-d.ttl).UnixMilli()

	d.mu.Lock()
	defer d.mu.Unlock()

	// Opportunistic cleanup.
	for id, ts := range d.seen {
		if ts < cutoffMs {
			delete(d.seen, id)
		}
	}

	if _, ok := d.seen[messageID]; ok {
		return false
	}
	d.seen[messageID] = nowMs

	// Bound size; delete arbitrary old entries.
	if d.max > 0 && len(d.seen) > d.max {
		n := len(d.seen) - d.max
		for id := range d.seen {
			delete(d.seen, id)
			n--
			if n <= 0 {
				break
			}
		}
	}

	return true
}

