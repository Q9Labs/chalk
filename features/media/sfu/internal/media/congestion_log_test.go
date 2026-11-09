package media

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"
)

func TestCongestionLogsIdentifySubscriptionAndDecision(t *testing.T) {
	var logs bytes.Buffer
	node := &Node{log: slog.New(slog.NewJSONHandler(&logs, nil))}
	// The same MID belongs to different subscriptions on different connections.
	for _, connectionID := range []string{"connection-a", "connection-b"} {
		sub := &subscription{
			owner: &Session{id: connectionID},
			mid:   "2",
			alloc: allocation{decided: true, rid: "l"},
			transport: &transport{estimator: bandwidthEstimator{
				estimate: 356_530, probeFloor: 356_530, probeUntil: 1, lossShare: 0.04,
				lastDecrease: decrease{at: 1, cause: causeOveruse, from: 900_000, to: 356_530, acked: 419_447},
			}},
		}
		for _, paused := range []bool{true, false} {
			node.logCongestionPause(sub, paused, 0)
			// An unchanged state must not emit another record.
			node.logCongestionPause(sub, paused, 0)
			var record map[string]any
			if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
				t.Fatalf("decode congestion log: %v", err)
			}
			message, reason := "subscription resumed after a congestion pause", "bandwidth_recovered"
			if paused {
				message, reason = "subscription paused for congestion", "insufficient_bandwidth"
			}
			for field, want := range map[string]any{
				"level": "INFO", "msg": message,
				"connectionId": connectionID, "mid": "2", "rid": "l", "reason": reason,
				"estimateBps": float64(356_530), "provenBps": float64(356_530),
				"deliveredShare": float64(1), "probing": false, "hostPressure": false,
				"lossShare": 0.04, "lossy": false, "trend": "normal", "ackedBps": float64(0),
				"decreaseCause": "overuse", "decreaseFromBps": float64(900_000), "decreaseToBps": float64(356_530), "decreaseAckedBps": float64(419_447),
			} {
				if got, ok := record[field]; !ok || got != want {
					t.Errorf("%s: %s = %v (present=%t), want %v", message, field, got, ok, want)
				}
			}
			logs.Reset()
		}
	}
}
