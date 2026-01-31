package websocket

import (
	"sync/atomic"
)

type wsMetricsSnapshot struct {
	sendEnqueued uint64
	sendDrops    uint64
	writeErrors  uint64
	pingErrors   uint64
}

var wsMetrics struct {
	sendEnqueued uint64
	sendDrops    uint64
	writeErrors  uint64
	pingErrors   uint64
}

func recordWSSendEnqueued() {
	atomic.AddUint64(&wsMetrics.sendEnqueued, 1)
}

func recordWSSendDrop() {
	atomic.AddUint64(&wsMetrics.sendDrops, 1)
}

func recordWSWriteError() {
	atomic.AddUint64(&wsMetrics.writeErrors, 1)
}

func recordWSPingError() {
	atomic.AddUint64(&wsMetrics.pingErrors, 1)
}

func snapshotWSMetrics() wsMetricsSnapshot {
	return wsMetricsSnapshot{
		sendEnqueued: atomic.LoadUint64(&wsMetrics.sendEnqueued),
		sendDrops:    atomic.LoadUint64(&wsMetrics.sendDrops),
		writeErrors:  atomic.LoadUint64(&wsMetrics.writeErrors),
		pingErrors:   atomic.LoadUint64(&wsMetrics.pingErrors),
	}
}
