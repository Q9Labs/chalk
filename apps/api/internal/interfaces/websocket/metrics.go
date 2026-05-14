package websocket

import (
	"sync/atomic"
)

type wsMetricsSnapshot struct {
	sendEnqueued       uint64
	sendDrops          uint64
	backpressureCloses uint64
	readEOFs           uint64
	readErrors         uint64
	writeErrors        uint64
	pingErrors         uint64
}

var wsMetrics struct {
	sendEnqueued       uint64
	sendDrops          uint64
	backpressureCloses uint64
	readEOFs           uint64
	readErrors         uint64
	writeErrors        uint64
	pingErrors         uint64
}

func recordWSSendEnqueued() {
	atomic.AddUint64(&wsMetrics.sendEnqueued, 1)
}

func recordWSSendDrop() {
	atomic.AddUint64(&wsMetrics.sendDrops, 1)
}

func recordWSSendBackpressureClose() {
	atomic.AddUint64(&wsMetrics.backpressureCloses, 1)
}

func recordWSReadEOF() {
	atomic.AddUint64(&wsMetrics.readEOFs, 1)
}

func recordWSReadError() {
	atomic.AddUint64(&wsMetrics.readErrors, 1)
}

func recordWSWriteError() {
	atomic.AddUint64(&wsMetrics.writeErrors, 1)
}

func recordWSPingError() {
	atomic.AddUint64(&wsMetrics.pingErrors, 1)
}

func snapshotWSMetrics() wsMetricsSnapshot {
	return wsMetricsSnapshot{
		sendEnqueued:       atomic.LoadUint64(&wsMetrics.sendEnqueued),
		sendDrops:          atomic.LoadUint64(&wsMetrics.sendDrops),
		backpressureCloses: atomic.LoadUint64(&wsMetrics.backpressureCloses),
		readEOFs:           atomic.LoadUint64(&wsMetrics.readEOFs),
		readErrors:         atomic.LoadUint64(&wsMetrics.readErrors),
		writeErrors:        atomic.LoadUint64(&wsMetrics.writeErrors),
		pingErrors:         atomic.LoadUint64(&wsMetrics.pingErrors),
	}
}
