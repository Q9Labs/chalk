package media

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"
	"time"
)

func TestCongestionLogsIdentifySubscriptionAndDecision(t *testing.T) {
	var logs bytes.Buffer
	node := &Node{log: slog.New(slog.NewJSONHandler(&logs, nil))}
	// The same MID belongs to different subscriptions on different connections.
	for _, connectionID := range []string{"connection-a", "connection-b"} {
		sub := &subscription{
			owner: &Session{kind: ParticipantSession, id: connectionID},
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

// The next staging run must tell which signal cut the estimate, so the pause
// log names the cause, the packet loss it saw and the rates it moved between.
func TestPauseLogNamesTheCauseOfTheLastCut(t *testing.T) {
	logOf := func(t *testing.T, tr *transport, now int64) map[string]any {
		t.Helper()
		var logs bytes.Buffer
		node := &Node{log: slog.New(slog.NewJSONHandler(&logs, nil))}
		node.logCongestionPause(&subscription{owner: &Session{kind: ParticipantSession, id: "c"}, mid: "1", alloc: allocation{decided: true, rid: "l"}, transport: tr}, true, now)
		var record map[string]any
		if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
			t.Fatalf("decode congestion log: %v", err)
		}
		return record
	}

	t.Run("loss", func(t *testing.T) {
		sim := newPathSim(300_000, simLayers)
		sim.run(2 * time.Second)
		before := sim.estimate()
		// 30 packets, 10 of them reported lost, then the next feedback.
		var acks []packetAck
		for i := range 30 {
			acks = append(acks, packetAck{sent: sim.now + int64(i)*int64(time.Millisecond), arrival: sim.now + sim.skew + int64(i)*int64(time.Millisecond), size: 500, received: i%3 != 0})
		}
		sim.now += int64(time.Second)
		sim.tr.estimator.onFeedback(acks, sim.now)
		record := logOf(t, sim.tr, sim.now+int64(500*time.Millisecond))
		if record["decreaseCause"] != "loss" || record["decreaseAgoMs"] != float64(500) {
			t.Errorf("cause %v ago %v, want loss 500 ms ago", record["decreaseCause"], record["decreaseAgoMs"])
		}
		if share, _ := record["lossShare"].(float64); share <= lossHigh || share > 0.34 {
			t.Errorf("lossShare %v, want over the heavy-loss line and up to 0.33", record["lossShare"])
		}
		if record["lossy"] != true {
			t.Errorf("lossy %v, want true", record["lossy"])
		}
		from, _ := record["decreaseFromBps"].(float64)
		to, _ := record["decreaseToBps"].(float64)
		if from < before*0.9 || to >= from {
			t.Errorf("cut from %v to %v, want a cut from about %.0f", from, to, before)
		}
	})

	t.Run("delay", func(t *testing.T) {
		sim := newPathSim(120_000, simLayers)
		sim.run(3 * time.Second)
		start := sim.now
		sim.extra = func(at int64) time.Duration {
			if at < start || at > start+int64(time.Second) {
				return 0
			}
			return time.Duration(float64(at-start) / float64(time.Second) * float64(250*time.Millisecond))
		}
		sim.run(4 * time.Second)
		record := logOf(t, sim.tr, sim.now)
		if record["decreaseCause"] != "overuse" || record["lossShare"] != float64(0) || record["lossy"] != false {
			t.Errorf("cause %v lossShare %v lossy %v, want overuse 0 false", record["decreaseCause"], record["lossShare"], record["lossy"])
		}
		from, _ := record["decreaseFromBps"].(float64)
		to, _ := record["decreaseToBps"].(float64)
		acked, _ := record["decreaseAckedBps"].(float64)
		if to > from || acked <= 0 {
			t.Errorf("cut from %v to %v with acked %v", from, to, acked)
		}
	})
}
